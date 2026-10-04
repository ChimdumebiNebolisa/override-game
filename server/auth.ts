import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type Database from 'better-sqlite3';
import { HttpError } from './http.js';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const DAY_MS = 24 * 60 * 60 * 1000;
const HANDLE_COOLDOWN_MS = 30 * DAY_MS;
const PROFANITY = ['fuck', 'shit', 'bitch', 'cunt'];

export interface GoogleVerificationOptions {
  /** Test seam; production callers should use GOOGLE_CLIENT_ID and Google's JWKS. */
  clientId?: string;
  keySet?: JWTVerifyGetKey;
}

export interface VerifiedGoogleIdentity {
  uid: string;
}

export interface PublicProfile {
  handle: string | null;
  rating: number;
  peakRating: number;
  placementProgress: number;
  ratedMatchCount: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
}

interface ProfileRow {
  uid: string;
  handle: string | null;
  normalized_handle: string | null;
  rating: number;
  peak_rating: number;
  placement_progress: number;
  rated_match_count: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  renamed_at: number | null;
  created_at: number;
}

export async function verifyGoogleIdToken(
  idToken: unknown,
  options: GoogleVerificationOptions = {},
): Promise<VerifiedGoogleIdentity> {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 16_384) {
    throw new HttpError(400, 'A Google ID token is required');
  }
  const clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(503, 'Google sign-in is not configured');

  try {
    const { payload } = await jwtVerify(idToken, options.keySet ?? GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new HttpError(401, 'Google ID token has no user identity');
    }
    return { uid: payload.sub };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Invalid Google ID token');
  }
}

/** Verify a Google ID token, bind the verified subject to an existing opaque session, and create its profile. */
export async function attachGoogleIdentity(
  db: Database.Database,
  sessionId: string,
  idToken: unknown,
  now = Date.now(),
  options: GoogleVerificationOptions = {},
): Promise<VerifiedGoogleIdentity> {
  const identity = await verifyGoogleIdToken(idToken, options);
  const attach = db.transaction(() => {
    const session = db.prepare('SELECT uid FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, now) as
      { uid: string | null } | undefined;
    if (!session) throw new HttpError(401, 'Session expired');
    if (session.uid && session.uid !== identity.uid) throw new HttpError(409, 'Session belongs to another account');

    db.prepare('INSERT OR IGNORE INTO profiles (uid, created_at) VALUES (?, ?)').run(identity.uid, now);
    db.prepare('UPDATE sessions SET uid = ? WHERE id = ? AND (uid IS NULL OR uid = ?)')
      .run(identity.uid, sessionId, identity.uid);
    return identity;
  });
  return attach.immediate();
}

export function validateHandle(value: unknown): { handle: string; normalizedHandle: string } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(value)) {
    throw new HttpError(400, 'Handle must be 3–16 letters, numbers, or underscores');
  }
  const normalizedHandle = value.toLowerCase();
  if (PROFANITY.some((word) => normalizedHandle.includes(word))) {
    throw new HttpError(400, 'Choose a different handle');
  }
  return { handle: value, normalizedHandle };
}

function profileExists(db: Database.Database, uid: string): ProfileRow {
  const row = db.prepare('SELECT * FROM profiles WHERE uid = ?').get(uid) as ProfileRow | undefined;
  if (!row) throw new HttpError(401, 'Sign in with Google first');
  return row;
}

function reserveHandle(db: Database.Database, uid: string, value: unknown, rename: boolean, now: number): PublicProfile {
  const { handle, normalizedHandle } = validateHandle(value);
  const update = db.transaction(() => {
    const current = profileExists(db, uid);
    if (rename && !current.handle) throw new HttpError(409, 'Choose your first handle before renaming');
    if (!rename && current.handle) throw new HttpError(409, 'A handle is already set');
    if (rename && current.renamed_at !== null && now < current.renamed_at + HANDLE_COOLDOWN_MS) {
      throw new HttpError(429, 'Handle can be changed once every 30 days');
    }
    try {
      if (rename) {
        db.prepare('UPDATE profiles SET handle = ?, normalized_handle = ?, renamed_at = ? WHERE uid = ?')
          .run(handle, normalizedHandle, now, uid);
      } else {
        db.prepare('UPDATE profiles SET handle = ?, normalized_handle = ? WHERE uid = ?')
          .run(handle, normalizedHandle, uid);
      }
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: profiles\.normalized_handle/.test(error.message)) {
        throw new HttpError(409, 'Handle is already taken');
      }
      throw error;
    }
    return getPublicProfile(db, uid)!;
  });
  return update.immediate();
}

/** Atomically set the account's initial handle. */
export function claimHandle(db: Database.Database, uid: string, value: unknown, now = Date.now()): PublicProfile {
  return reserveHandle(db, uid, value, false, now);
}

/** Atomically rename a handle; the first rename has no cooldown and starts the 30-day interval. */
export function renameHandle(db: Database.Database, uid: string, value: unknown, now = Date.now()): PublicProfile {
  return reserveHandle(db, uid, value, true, now);
}

/** Return only intended competitive profile fields; never expose the UID, email, or persistence metadata. */
export function getPublicProfile(db: Database.Database, uid: string): PublicProfile | null {
  const row = db.prepare(`
    SELECT handle, rating, peak_rating, placement_progress, rated_match_count, wins, losses, draws, streak
    FROM profiles WHERE uid = ?
  `).get(uid) as Omit<ProfileRow, 'uid' | 'normalized_handle' | 'renamed_at' | 'created_at'> | undefined;
  if (!row) return null;
  return {
    handle: row.handle,
    rating: row.rating,
    peakRating: row.peak_rating,
    placementProgress: row.placement_progress,
    ratedMatchCount: row.rated_match_count,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    streak: row.streak,
  };
}
