import { describe, expect, test } from "bun:test";
import { tick, seedFrom, DEFAULT_CONFIG } from "../src/tick.ts";
import { SEC, MIN, HOUR, LADDER, MAX_RUNG, highestDueRung } from "../src/ladder.ts";
import { stateKey } from "../src/types.ts";
import type { Session, State, Snooze } from "../src/types.ts";

const T0 = 1_700_000_000_000;

function sess(over: Partial<Session> = {}): Session {
  return {
    sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
    pid: 1234,
    name: "erp-00",
    nameSource: "derived",
    kind: "interactive",
    cwd: "/Users/x/acme/erp",
    status: "waiting",
    waitingFor: "input needed",
    blockedSince: T0,
    startedAt: T0 - HOUR,
    durationKnown: true,
    ...over,
  };
}

function st(s: Session, lastRung: number, lastNotifiedAt: number | null = null): State {
  return {
    [stateKey(s.sessionId, s.blockedSince)]: {
      sessionId: s.sessionId,
      blockedSince: s.blockedSince,
      lastRung,
      lastNotifiedAt,
      lastSeenAt: T0,
    },
  };
}

const noSnooze: Snooze[] = [];

describe("silent-failure guards", () => {
  test("T1 flap: a re-blocked session starts a FRESH ladder, not the old one", () => {
    // The killer bug: with state keyed on sessionId alone and only a timestamp
    // persisted, a re-block inherits the previous ladder position, so it either
    // stays silent for hours or shouts "waiting 8h" about a 2-minute-old question.
    // Keying on blockedSince makes it a brand new entry at rung 0.
    const old = sess({ blockedSince: T0 });
    const state = st(old, 3, T0 + 8 * HOUR); // 8h rung already delivered on the OLD block
    const reblocked = sess({ blockedSince: T0 + 9 * HOUR });

    // Inside the first rung: nothing yet, even though the old block was deep in.
    const early = tick({ now: T0 + 9 * HOUR + 10 * SEC, sessions: [reblocked], state, snoozes: noSnooze });
    expect(early.notifications).toHaveLength(0);
    expect(early.nextState[stateKey(reblocked.sessionId, reblocked.blockedSince)]!.lastRung).toBe(-1);

    // Past it: rung 0, the fresh one — never the inherited rung 3.
    const out = tick({ now: T0 + 9 * HOUR + 2 * MIN, sessions: [reblocked], state, snoozes: noSnooze });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.rung).toBe(0);
  });

  test("T2 a 9h sleep crossing three rungs emits ONE notification, at the highest", () => {
    const s = sess();
    const out = tick({ now: T0 + 9 * HOUR, sessions: [s], state: st(s, 0, T0 + 30 * MIN), snoozes: noSnooze });

    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.rung).toBe(highestDueRung(T0, T0 + 9 * HOUR));
    expect(out.notifications[0]!.title).toContain("9h");
  });

  test("T3 cold start on a 26h block fires a high rung, never the 30m rung", () => {
    // The headline demo. A naive implementation says "erp-00 waiting 30m" about a
    // session that has been blocked for more than a day.
    const s = sess();
    const out = tick({ now: T0 + 26 * HOUR, sessions: [s], state: {}, snoozes: noSnooze });

    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.rung).toBe(MAX_RUNG);   // top rung, never rung 0
    expect(out.notifications[0]!.title).toContain("26h");
  });

  test("T4 clock stepping backwards: no notification, no negative, logged once", () => {
    const s = sess({ blockedSince: T0 + 3 * HOUR });
    const out = tick({ now: T0, sessions: [s], state: {}, snoozes: noSnooze });

    expect(out.notifications).toHaveLength(0);
    expect(out.logLines.join(" ")).toMatch(/clock/i);
  });

  test("T5 snooze suppresses; an expired snooze does not", () => {
    const s = sess();
    const active: Snooze[] = [{ sessionId: s.sessionId, blockedSince: s.blockedSince, until: T0 + 5 * HOUR }];
    const expired: Snooze[] = [{ sessionId: s.sessionId, blockedSince: s.blockedSince, until: T0 + HOUR }];

    expect(tick({ now: T0 + 3 * HOUR, sessions: [s], state: {}, snoozes: active }).notifications).toHaveLength(0);
    expect(tick({ now: T0 + 3 * HOUR, sessions: [s], state: {}, snoozes: expired }).notifications).toHaveLength(1);
  });

  test("T5b a suppressed rung is re-offered once the snooze lapses", () => {
    // lastRung must advance only on DELIVERY, never on suppression.
    const s = sess();
    const snoozed: Snooze[] = [{ sessionId: s.sessionId, blockedSince: s.blockedSince, until: T0 + 5 * HOUR }];
    const first = tick({ now: T0 + 3 * HOUR, sessions: [s], state: {}, snoozes: snoozed });
    expect(first.nextState[stateKey(s.sessionId, s.blockedSince)]!.lastRung).toBe(-1);

    const later = tick({ now: T0 + 6 * HOUR, sessions: [s], state: first.nextState, snoozes: [] });
    expect(later.notifications).toHaveLength(1);
  });

  test("T6 non-waiting sessions never emit", () => {
    for (const status of ["busy", "idle"] as const) {
      const out = tick({ now: T0 + 26 * HOUR, sessions: [sess({ status })], state: {}, snoozes: noSnooze });
      expect(out.notifications).toHaveLength(0);
    }
  });

  test("T6a the ladder is finite: a 30-day block emits exactly 5 notifications, ever", () => {
    // Correctness must not depend on Claude Code's status field clearing. If it
    // ever sticks, the blast radius is five notifications over two days.
    const s = sess();
    let state: State = {};
    let total = 0;
    for (let h = 0; h <= 24 * 30; h++) {
      const out = tick({ now: T0 + h * HOUR, sessions: [s], state, snoozes: noSnooze });
      total += out.notifications.length;
      state = out.nextState;
    }
    // Bounded is the property that matters: a stuck session can never nag forever.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(LADDER.length);
    expect(state[stateKey(s.sessionId, s.blockedSince)]!.lastRung).toBe(MAX_RUNG);
  });

  test("T6b ack silences THIS block forever, but a new block still notifies", () => {
    const s = sess();
    const ack: Snooze[] = [{ sessionId: s.sessionId, blockedSince: s.blockedSince, until: null }];

    expect(tick({ now: T0 + 40 * HOUR, sessions: [s], state: {}, snoozes: ack }).notifications).toHaveLength(0);

    const fresh = sess({ blockedSince: T0 + 50 * HOUR });
    const out = tick({ now: T0 + 51 * HOUR, sessions: [fresh], state: {}, snoozes: ack });
    expect(out.notifications).toHaveLength(1);
  });

  test("T6c a new blockedSince resets the ladder to rung 0 behaviour", () => {
    const s = sess();
    const exhausted = st(s, MAX_RUNG, T0 + 48 * HOUR);
    const newQuestion = sess({ blockedSince: T0 + 60 * HOUR });

    const early = tick({ now: T0 + 60 * HOUR + 10 * SEC, sessions: [newQuestion], state: exhausted, snoozes: noSnooze });
    expect(early.notifications).toHaveLength(0); // inside the first rung

    const fired = tick({ now: T0 + 60 * HOUR + 2 * MIN, sessions: [newQuestion], state: early.nextState, snoozes: noSnooze });
    expect(fired.notifications).toHaveLength(1);
    expect(fired.notifications[0]!.rung).toBe(0);   // rung 0, despite the old ladder being exhausted
  });
});

describe("coalescing and recovery", () => {
  test("seven sessions crossing a rung together emit ONE notification", () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      sess({ sessionId: `s${i}-uuid`, name: `sess-${i}`, blockedSince: T0 - i * MIN })
    );
    const out = tick({ now: T0 + 2 * HOUR + MIN, sessions, state: {}, snoozes: noSnooze });

    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.kind).toBe("coalesced");
    expect(out.notifications[0]!.title).toBe("7 sessions waiting");
    expect(out.notifications[0]!.sessionIds).toHaveLength(7);
  });

  test("seedFrom marks current blocks as already delivered — recovery is quiet, not loud", () => {
    const s = sess();
    const seeded = seedFrom([s], T0 + 26 * HOUR);
    const out = tick({ now: T0 + 26 * HOUR, sessions: [s], state: seeded, snoozes: noSnooze });
    expect(out.notifications).toHaveLength(0);
  });

  test("state is garbage-collected once a session is gone and stale", () => {
    const gone = stateKey("dead-session", T0);
    const state: State = {
      [gone]: { sessionId: "dead-session", blockedSince: T0, lastRung: 1, lastNotifiedAt: T0, lastSeenAt: T0 },
    };
    const now = T0 + DEFAULT_CONFIG.stateTtlMs + HOUR;
    const out = tick({ now, sessions: [], state, snoozes: noSnooze });
    expect(out.nextState[gone]).toBeUndefined();
  });

  test("durationKnown:false sessions are never escalated", () => {
    const s = sess({ durationKnown: false, blockedSince: 0 });
    const out = tick({ now: T0 + 26 * HOUR, sessions: [s], state: {}, snoozes: noSnooze });
    expect(out.notifications).toHaveLength(0);
  });
});

describe("idle cost", () => {
  test("repeated ticks produce byte-identical state, so nothing is rewritten", () => {
    // lastSeenAt used to store `now` verbatim, so the state differed every tick and
    // the daemon fsynced state.json every 5 seconds forever. It is quantised now.
    const s = sess();
    let state: State = {};
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = tick({ now: T0 + 3 * HOUR + i * 5000, sessions: [s], state, snoozes: noSnooze });
      state = out.nextState;
      seen.add(JSON.stringify(state));
    }
    // One shape while the rung fires, one after. Never twenty.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  test("lastSeenAt still advances enough for the 7-day GC to work", () => {
    const s = sess();
    const a = tick({ now: T0 + 3 * HOUR, sessions: [s], state: {}, snoozes: noSnooze });
    const b = tick({ now: T0 + 3 * HOUR + 8 * 60_000, sessions: [s], state: a.nextState, snoozes: noSnooze });
    const k = stateKey(s.sessionId, s.blockedSince);
    expect(b.nextState[k]!.lastSeenAt).toBeGreaterThan(a.nextState[k]!.lastSeenAt);
  });
});
