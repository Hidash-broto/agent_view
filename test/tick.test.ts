import { describe, expect, test } from "bun:test";
import { tick, seedFrom, DEFAULT_CONFIG } from "../src/tick.ts";
import { MIN, HOUR, LADDER, MAX_RUNG } from "../src/ladder.ts";
import { stateKey } from "../src/types.ts";
import type { Session, State, Snooze } from "../src/types.ts";

const T0 = 1_700_000_000_000;

function sess(over: Partial<Session> = {}): Session {
  return {
    sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
    pid: 1234,
    name: "erp-00",
    nameSource: "derived",
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
  test("T1 flap: answered then re-blocked 2m ago emits NOTHING", () => {
    // The killer bug. With state keyed on sessionId alone and only a timestamp
    // persisted, "3h since we last notified" would fire instantly on a 2-minute
    // block. Keying on blockedSince makes the re-block a brand new entry.
    const old = sess({ blockedSince: T0 });
    const state = st(old, 2, T0 + 8 * HOUR); // delivered the 8h rung on the OLD block
    const reblocked = sess({ blockedSince: T0 + 9 * HOUR });

    const out = tick({ now: T0 + 9 * HOUR + 2 * MIN, sessions: [reblocked], state, snoozes: noSnooze });

    expect(out.notifications).toHaveLength(0);
    const key = stateKey(reblocked.sessionId, reblocked.blockedSince);
    expect(out.nextState[key]!.lastRung).toBe(-1);
  });

  test("T2 9h sleep crossing 30m+2h+8h emits ONE notification at the 8h rung", () => {
    const s = sess();
    const out = tick({ now: T0 + 9 * HOUR, sessions: [s], state: st(s, 0, T0 + 30 * MIN), snoozes: noSnooze });

    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.rung).toBe(2);
    expect(out.notifications[0]!.title).toContain("9h");
  });

  test("T3 cold start on a 26h block fires a high rung, never the 30m rung", () => {
    // The headline demo. A naive implementation says "erp-00 waiting 30m" about a
    // session that has been blocked for more than a day.
    const s = sess();
    const out = tick({ now: T0 + 26 * HOUR, sessions: [s], state: {}, snoozes: noSnooze });

    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]!.rung).toBe(3);
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
    expect(total).toBe(LADDER.length);
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

    const early = tick({ now: T0 + 60 * HOUR + 10 * MIN, sessions: [newQuestion], state: exhausted, snoozes: noSnooze });
    expect(early.notifications).toHaveLength(0); // 10 minutes is not 30

    const at30 = tick({ now: T0 + 60 * HOUR + 31 * MIN, sessions: [newQuestion], state: early.nextState, snoozes: noSnooze });
    expect(at30.notifications).toHaveLength(1);
    expect(at30.notifications[0]!.rung).toBe(0);
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
