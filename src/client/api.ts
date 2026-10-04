import type { Action, MatchState, Player, RoundResult } from "../shared/rules";

export type RoomStatus = "open" | "full" | "readying" | "active" | "finished" | "expired";

export interface Room {
  id: string;
  code: string;
  inviteUrl: string;
  status: RoomStatus;
  hostDisplayName: string;
  guestDisplayName?: string;
}

export interface RoomResponse {
  room: Room;
  match?: unknown;
}

export interface MatchResponse<TMatch = unknown> {
  match: TMatch;
}

export interface PublicMatch {
  id: string;
  roomId: string | null;
  mode: "quick" | "practice" | "ranked";
  botDifficulty: "easy" | "normal" | "hard" | null;
  player: Player;
  playerNames: Record<Player, string>;
  state: MatchState;
  score: Record<Player, number>;
  status: "readying" | "decision" | "transition" | "grace" | "finished" | "voided";
  deadline: number | null;
  serverNow: number;
  revision: number;
  locked: boolean;
  lastResult: RoundResult | null;
  resultType: string | null;
  competitiveMultiplier: number | null;
  afkMisses?: number;
  afkWarning?: boolean;
}

export function snapshotIsCurrent(snapshot: Pick<PublicMatch, "revision">, currentRevision: number): boolean {
  return snapshot.revision >= currentRevision;
}

export interface RankedProfile {
  handle: string | null;
  rating?: number;
  peakRating?: number;
  placementProgress?: number;
  ratedMatchCount?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  streak?: number;
  tier?: string | null;
  rank?: number | null;
}

export interface RankedQueue {
  state: "searching" | "readying" | "active" | "cooldown" | "timed-out" | "ready-expired";
  matchId: string | null;
  competitiveMultiplier: number | null;
  readyDeadline: number | null;
  cooldownUntil?: number;
}

export interface RankedInvitation {
  id: string;
  token: string;
  inviteUrl: string;
  kind: "challenge" | "rematch";
  expiresAt: number;
}

export interface QuickRematchInvitation {
  token: string;
  inviteUrl?: string;
  expiresAt?: number;
}

export interface RankedShell {
  matchId: string;
  competitiveMultiplier: number;
  creditAssessedAt: number;
  readyDeadline: number;
}

export interface SettlementPlayer {
  outcome: "win" | "loss" | "draw";
  placementProgress: number;
  delta?: number;
  ratingBefore?: number;
  ratingAfter?: number;
}

export interface RankedSettlement {
  multiplier: number;
  player: SettlementPlayer;
}

export interface LeaderboardEntry {
  handle: string;
  rating: number;
  rank: number;
  tier: string;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "override-game",
        ...init?.headers,
      },
    });
  } catch {
    throw new Error("The game server is unavailable. Check your connection and try again.");
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "The request could not be completed.");
  }

  if (!payload) {
    throw new Error("The game server returned an invalid response.");
  }

  return payload;
}

function subscribeLive(path: string, onInvalidate: () => void, onOpen?: () => void, onClose?: () => void) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}${path}`;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener("open", () => {
      if (stopped || socket !== current) return;
      onOpen?.();
      onInvalidate();
    });
    current.addEventListener("message", () => {
      if (!stopped && socket === current) onInvalidate();
    });
    current.addEventListener("error", () => current.close());
    current.addEventListener("close", () => {
      if (stopped || socket !== current) return;
      socket = null;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, 1_000);
      onClose?.();
    });
  };

  connect();
  return () => {
    stopped = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
    socket = null;
  };
}

export const api = {
  createRoom(displayName: string, creationKey: string) {
    return request<RoomResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName, creationKey }),
    });
  },

  joinRoom(code: string, displayName: string) {
    return request<RoomResponse>("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ code, displayName }),
    });
  },

  joinInvite(token: string, displayName: string) {
    return request<RoomResponse>("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ token, displayName }),
    });
  },

  getRoom(roomId: string) {
    return request<RoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}`);
  },

  readyRoom(roomId: string) {
    return request<RoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}/ready`, {
      method: "POST",
      body: "{}",
    });
  },

  closeRoom(roomId: string) {
    return request<{ closed: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
  },

  createBotMatch(mode: "quick" | "practice", difficulty: "easy" | "normal" | "hard", creationKey: string, parentMatchId?: string, restartMatchId?: string) {
    return request<MatchResponse<PublicMatch>>("/api/bot-matches", {
      method: "POST",
      body: JSON.stringify({ displayName: "Player", mode, difficulty, parentMatchId, restartMatchId, creationKey }),
    });
  },

  getMatch<TMatch = unknown>(matchId: string) {
    return request<MatchResponse<TMatch>>(
      `/api/matches/${encodeURIComponent(matchId)}`,
    );
  },

  lockAction(matchId: string, action: Action, round: number, revision: number) {
    return request<MatchResponse<PublicMatch>>(
      `/api/matches/${encodeURIComponent(matchId)}/actions`,
      {
        method: "POST",
        body: JSON.stringify({ action, round, revision }),
      },
    );
  },

  subscribe(roomId: string, onInvalidate: () => void) {
    return subscribeLive(`/api/live?roomId=${encodeURIComponent(roomId)}`, onInvalidate);
  },

  subscribeMatch(matchId: string, onInvalidate: () => void, onOpen?: () => void, onClose?: () => void) {
    return subscribeLive(`/api/live?matchId=${encodeURIComponent(matchId)}`, onInvalidate, onOpen, onClose);
  },

  getConfig() {
    return request<{ googleClientId: string | null }>("/api/config");
  },

  getGoogleNonce() {
    return request<{ nonce: string }>("/api/auth/google/nonce", { method: "POST", body: "{}" });
  },

  getSession() {
    return request<{ signedIn: boolean; profile: RankedProfile | null }>("/api/session");
  },

  getResume() {
    return request<{ match: PublicMatch | null; room: Room | null; rankedQueue: RankedQueue | null; rankedChallenge: RankedInvitation | null }>("/api/resume");
  },

  trackEvent(name: "homepage_opened" | "mode_selected" | "opponent_selected" | "ranked_auth_started", mode?: string) {
    return request<{ recorded: boolean }>("/api/telemetry", {
      method: "POST",
      body: JSON.stringify({ name, mode: mode ?? null }),
    });
  },

  googleSignIn(idToken: string) {
    return request<{ profile: RankedProfile | null }>("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
  },

  claimHandle(handle: string) {
    return request<{ profile: RankedProfile }>("/api/profile/handle", {
      method: "POST",
      body: JSON.stringify({ handle }),
    });
  },

  renameHandle(handle: string) {
    return request<{ profile: RankedProfile }>("/api/profile/rename", {
      method: "POST",
      body: JSON.stringify({ handle }),
    });
  },

  getProfile() {
    return request<{ profile: RankedProfile }>("/api/profile/me");
  },

  enterRankedQueue() {
    return request<{ queue: RankedQueue }>("/api/ranked/queue", { method: "POST", body: "{}" });
  },

  getRankedQueue() {
    return request<{ queue: RankedQueue | null }>("/api/ranked/queue");
  },

  leaveRankedQueue() {
    return request<{ left: boolean }>("/api/ranked/queue", { method: "DELETE" });
  },

  readyRankedMatch(matchId: string) {
    return request<{ queue: RankedQueue }>(`/api/ranked/matches/${encodeURIComponent(matchId)}/ready`, { method: "POST", body: "{}" });
  },

  createRankedChallenge() {
    return request<{ invitation: RankedInvitation }>("/api/ranked/challenges", { method: "POST", body: "{}" });
  },

  getCurrentRankedChallenge() {
    return request<{ invitation: RankedInvitation | null }>("/api/ranked/challenges/current");
  },

  getRankedSettlement(matchId: string) {
    return request<{ settlement: RankedSettlement | null }>(`/api/matches/${encodeURIComponent(matchId)}/settlement`);
  },

  requestRankedRematch(matchId: string) {
    return request<{ invitation: RankedInvitation }>(`/api/ranked/matches/${encodeURIComponent(matchId)}/rematch`, { method: "POST", body: "{}" });
  },

  getRankedRematch(matchId: string) {
    return request<{ invitation: RankedInvitation | null; requestedByYou: boolean }>(`/api/ranked/matches/${encodeURIComponent(matchId)}/rematch`);
  },

  requestQuickRematch(matchId: string) {
    return request<{ invitation: QuickRematchInvitation }>(`/api/matches/${encodeURIComponent(matchId)}/rematch`, { method: "POST", body: "{}" });
  },

  getQuickRematch(matchId: string) {
    return request<{ invitation: QuickRematchInvitation | null; match?: PublicMatch | null; requestedByYou: boolean }>(`/api/matches/${encodeURIComponent(matchId)}/rematch`);
  },

  acceptQuickRematch(matchId: string, token: string) {
    return request<MatchResponse<PublicMatch>>(`/api/matches/${encodeURIComponent(matchId)}/rematch/accept`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  acceptQuickRematchInvite(token: string) {
    return request<MatchResponse<PublicMatch>>("/api/quick/rematches/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  acceptRankedInvite(kind: "challenge" | "rematch", token: string) {
    return request<{ shell: RankedShell }>(`/api/ranked/${kind === "challenge" ? "challenges" : "rematches"}/accept`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  resignMatch(matchId: string) {
    return request<MatchResponse<PublicMatch>>(`/api/matches/${encodeURIComponent(matchId)}/resign`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
  },

  getLeaderboard() {
    return request<{ top: LeaderboardEntry[]; around: LeaderboardEntry[]; selfRank: number | null }>("/api/leaderboard");
  },
};
