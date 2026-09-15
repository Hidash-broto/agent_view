/**
 * The decision seam. PURE: no I/O, no Date.now(), no side effects.
 *
 * "Given the sessions, the persisted state, the snoozes, and now — what do I emit
 * and what do I persist?" Without this file that logic lives inside the daemon's
 * while-loop, which is the one place that cannot be unit-tested, and every hard
 * case (flap, sleep, cold start, clock skew, coalescing) lives in exactly there.
 */

import { highestDueRung, isExhausted, LADDER, MAX_RUNG } from "./ladder.ts";
import { humanize, absoluteTime, label } from "./format.ts";
import { stateKey } from "./types.ts";
import type { Config, Notification, Session, Snooze, State } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  ladderMs: LADDER,
  pollMs: 5_000,
  stateTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export interface TickInput {
  now: number;
  sessions: Session[];
  state: State;
  snoozes: Snooze[];
  config?: Config;
}

export interface TickOutput {
  notifications: Notification[];
  nextState: State;
  logLines: string[];
}

function silenced(snoozes: Snooze[], sessionId: string, blockedSince: number, now: number): boolean {
  for (const s of snoozes) {
    if (s.sessionId !== sessionId) continue;
    // ack (until === null) is scoped to THIS block. A genuinely new question gets a
    // new blockedSince and therefore notifies again.
    if (s.until === null) {
      if (s.blockedSince === blockedSince) return true;
      continue;
    }
    if (s.until > now) return true;
  }
  return false;
}

function single(s: Session, rung: number, now: number, ladder: readonly number[]): Notification {
  const dur = humanize(now - s.blockedSince);
  const since = absoluteTime(s.blockedSince, now);
  const where = label(s).split("  ")[0];
  const last = rung >= ladder.length - 1;
  let body: string;
  if (rung === 0) body = `Blocked since ${since}.`;
  else if (rung === 1) body = `Nothing since ${since}. Or: agentview ack ${s.name}`;
  else if (last) body = `Last reminder. Still blocked since ${since}.`;
  else body = `Still blocked since ${since}. Or: agentview ack ${s.name}`;
  return {
    kind: "single",
    rung,
    title: `${s.name} waiting ${dur}`,
    subtitle: `${where} — ${s.waitingFor ?? "input needed"}`,
    body,
    sessionIds: [s.sessionId],
  };
}

function coalesce(items: { s: Session; rung: number }[], now: number): Notification {
  const sorted = [...items].sort((a, b) => a.s.blockedSince - b.s.blockedSince);
  const oldest = sorted[0]!.s;
  const rest = sorted.slice(1, 3).map((x) => `${x.s.name} (${humanize(now - x.s.blockedSince)})`);
  const more = sorted.length > 3 ? `, +${sorted.length - 3} more` : "";
  return {
    kind: "coalesced",
    rung: Math.max(...items.map((i) => i.rung)),
    title: `${items.length} sessions waiting`,
    subtitle: `Oldest: ${oldest.name}, ${humanize(now - oldest.blockedSince)}`,
    body: rest.length ? `Also ${rest.join(", ")}${more}. Run: agentview` : "Run: agentview",
    sessionIds: sorted.map((x) => x.s.sessionId),
  };
}

export function tick(input: TickInput): TickOutput {
  const { now, sessions, state, snoozes } = input;
  const config = input.config ?? DEFAULT_CONFIG;
  const ladder = config.ladderMs;
  const logLines: string[] = [];
  const nextState: State = {};
  const fired: { s: Session; rung: number }[] = [];

  const liveIds = new Set(sessions.map((s) => s.sessionId));
  const blocked = sessions.filter((s) => s.status === "waiting" && s.durationKnown);

  for (const s of blocked) {
    const key = stateKey(s.sessionId, s.blockedSince);
    const prev = state[key];
    const lastRung = prev?.lastRung ?? -1;

    // Clock stepped backwards (NTP). Never fabricate, never fire, say so once.
    if (now < s.blockedSince) {
      logLines.push(`clock: ${s.name} blockedSince is ${s.blockedSince - now}ms in the future`);
      nextState[key] = {
        sessionId: s.sessionId, blockedSince: s.blockedSince,
        lastRung, lastNotifiedAt: prev?.lastNotifiedAt ?? null, lastSeenAt: now,
      };
      continue;
    }

    const due = highestDueRung(s.blockedSince, now, ladder);
    const quiet = silenced(snoozes, s.sessionId, s.blockedSince, now);
    const shouldFire = due > lastRung && !isExhausted(lastRung, ladder) && !quiet;

    if (shouldFire) fired.push({ s, rung: due });

    nextState[key] = {
      sessionId: s.sessionId,
      blockedSince: s.blockedSince,
      // lastRung advances ONLY on delivery, so a snoozed rung is re-offered later.
      lastRung: shouldFire ? due : lastRung,
      lastNotifiedAt: shouldFire ? now : prev?.lastNotifiedAt ?? null,
      lastSeenAt: now,
    };

    if (shouldFire && due >= ladder.length - 1) {
      logLines.push(`${s.name}: final rung delivered — silent from here, list-only`);
    }
  }

  // Carry forward entries for sessions still alive but no longer blocked, and GC
  // anything neither live nor recent. Bounded by churn, not by uptime.
  for (const [key, entry] of Object.entries(state)) {
    if (nextState[key]) continue;
    const stale = now - entry.lastSeenAt > config.stateTtlMs;
    if (!liveIds.has(entry.sessionId) && stale) continue;
    nextState[key] = entry;
  }

  const notifications =
    fired.length === 0 ? []
    : fired.length === 1 ? [single(fired[0]!.s, fired[0]!.rung, now, ladder)]
    : [coalesce(fired, now)];

  return { notifications, nextState, logLines };
}

/** Recovery seeding: after losing state, mark every current block as already
 *  delivered at its highest due rung. Costs one missed notification; prevents a
 *  storm. Degrade quiet, never loud. */
export function seedFrom(sessions: Session[], now: number, ladder = LADDER): State {
  const out: State = {};
  for (const s of sessions) {
    if (s.status !== "waiting" || !s.durationKnown) continue;
    const rung = highestDueRung(s.blockedSince, now, ladder);
    out[stateKey(s.sessionId, s.blockedSince)] = {
      sessionId: s.sessionId, blockedSince: s.blockedSince,
      lastRung: rung, lastNotifiedAt: rung >= 0 ? now : null, lastSeenAt: now,
    };
  }
  return out;
}

export { MAX_RUNG };
