export type Status = "waiting" | "busy" | "idle";

/** A live Claude Code session, joined from the state file (+ liveness). */
export interface Session {
  sessionId: string;
  pid: number;
  name: string;
  /** "derived" = cwd slug (no real name). "user" = /rename. "auto" = Claude generated it. */
  nameSource: string;
  cwd: string;
  status: Status;
  waitingFor?: string;
  /** statusUpdatedAt. A TRANSITION timestamp, not a heartbeat. Verified 2026-09-10. */
  blockedSince: number;
  /** epoch ms. The pid-reuse guard. NOT procStart, which is UTC formatted as local. */
  startedAt: number;
  /** false in CLI-fallback mode, where no duration is available. Never fabricate one. */
  durationKnown: boolean;
}

/** Persisted per-block. The key is `${sessionId}:${blockedSince}` — a new block is a new key. */
export interface SessionState {
  sessionId: string;
  blockedSince: number;
  /** -1 = nothing delivered yet. Persisting the RUNG (not just a timestamp) is what
   *  makes cold start, sleep, and restart all produce the right notification. */
  lastRung: number;
  lastNotifiedAt: number | null;
  lastSeenAt: number;
}

export type State = Record<string, SessionState>;

/** `snooze` sets `until`. `ack` sets until = null, meaning "never again for this block". */
export interface Snooze {
  sessionId: string;
  blockedSince: number;
  until: number | null;
}

export interface Notification {
  kind: "single" | "coalesced";
  rung: number;
  title: string;
  subtitle: string;
  body: string;
  sessionIds: string[];
}

export interface Config {
  ladderMs: readonly number[];
  pollMs: number;
  /** Entries older than this with no live session are garbage-collected. */
  stateTtlMs: number;
}

export function stateKey(sessionId: string, blockedSince: number): string {
  return `${sessionId}:${blockedSince}`;
}
