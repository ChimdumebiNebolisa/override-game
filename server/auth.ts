import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type Database from 'better-sqlite3';
import { HttpError } from './http.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HANDLE_COOLDOWN_MS = 30 * DAY_MS;
const PROFANITY = ['fuck', 'shit', 'bitch', 'cunt'];

export interface VerifiedFirebaseIdentity {
  uid: string;
}

export interface PublicProfile {
  handle: string | null;
  rating?: number;
  peakRating?: number;
  placementProgress: number;
  ratedMatchCount?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  streak?: number;
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

export async function verifyFirebaseIdToken(idToken: unknown, verify?: (token: string) => Promise<{ uid: string; firebase?: { sign_in_provider?: string } }>): Promise<VerifiedFirebaseIdentity> {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 16_384) {
    throw new HttpError(400, 'A Firebase ID token is required');
  }
  try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!verify && !serviceAccount) throw new HttpError(503, 'Firebase Authentication is not configured');
    const decoded = verify
      ? await verify(idToken)
      : await getAuth(getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(serviceAccount!)) })).verifyIdToken(idToken);
    if (typeof decoded.uid !== 'string' || !decoded.uid || decoded.firebase?.sign_in_provider !== 'google.com') {
      throw new HttpError(401, 'Sign in with Google to continue');
    }
    return { uid: decoded.uid };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Invalid Firebase ID token');
  }
}

/** Verify a Firebase ID token, bind its UID to the opaque game session, and create its profile. */
export async function attachFirebaseIdentity(
  db: Database.Database,
  sessionId: string,
  idToken: unknown,
  now = Date.now(),
  verify?: (token: string) => Promise<{ uid: string; firebase?: { sign_in_provider?: string } }>,
): Promise<VerifiedFirebaseIdentity> {
  const challenge = db.prepare('SELECT uid, expires_at FROM sessions WHERE id = ?').get(sessionId) as { uid: string | null; expires_at: number } | undefined;
  if (!challenge || challenge.expires_at <= now) throw new HttpError(401, 'Session expired');
  if (challenge.uid) throw new HttpError(409, 'Session belongs to another account');
  const identity = await verifyFirebaseIdToken(idToken, verify);
  const attach = db.transaction(() => {
    const session = db.prepare('SELECT uid, expires_at FROM sessions WHERE id = ?').get(sessionId) as { uid: string | null; expires_at: number } | undefined;
    if (!session) throw new HttpError(401, 'Session expired');
    if (session.expires_at <= now) throw new HttpError(401, 'Session expired');
    if (session.uid && session.uid !== identity.uid) throw new HttpError(409, 'Session belongs to another account');
    if (session.uid) throw new HttpError(409, 'Session is already signed in');

    db.prepare('INSERT OR IGNORE INTO profiles (uid, created_at) VALUES (?, ?)').run(identity.uid, now);
    const consumed = db.prepare('UPDATE sessions SET uid = ? WHERE id = ? AND uid IS NULL AND expires_at > ?').run(identity.uid, sessionId, now);
    if (consumed.changes !== 1) throw new HttpError(409, 'Session is already signed in');
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
  const profile: PublicProfile = {
    handle: row.handle,
    placementProgress: row.placement_progress,
  };
  if (row.placement_progress >= 5) {
    profile.rating = row.rating;
    profile.peakRating = row.peak_rating;
    profile.ratedMatchCount = row.rated_match_count;
    profile.wins = row.wins;
    profile.losses = row.losses;
    profile.draws = row.draws;
    profile.streak = row.streak;
  }
  return profile;
}
