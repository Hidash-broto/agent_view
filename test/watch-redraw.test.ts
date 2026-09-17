import { describe, expect, test } from "bun:test";

/** The redraw fingerprint. Mirrors watch.ts's snapshot(); the bug it guards is that
 *  filtering to blocked sessions made every other change invisible until the
 *  10-minute heartbeat, including the session count in the header. */
function snapshot(sessions: { status: string; sessionId: string; blockedSince: number }[]): string {
  return sessions.map((s) => `${s.sessionId}:${s.status}:${s.blockedSince}`).sort().join("|");
}

const s = (id: string, status: string, blockedSince = 0) => ({ sessionId: id, status, blockedSince });

describe("redraw fingerprint", () => {
  test("a new session changes it", () => {
    expect(snapshot([s("a", "idle")])).not.toBe(snapshot([s("a", "idle"), s("b", "busy")]));
  });

  test("a session ending changes it", () => {
    expect(snapshot([s("a", "idle"), s("b", "idle")])).not.toBe(snapshot([s("a", "idle")]));
  });

  test("busy -> idle changes it, even though neither state is 'waiting'", () => {
    // This is the exact case that used to leave the screen stale.
    expect(snapshot([s("a", "busy")])).not.toBe(snapshot([s("a", "idle")]));
  });

  test("a session becoming blocked changes it", () => {
    expect(snapshot([s("a", "idle")])).not.toBe(snapshot([s("a", "waiting", 123)]));
  });

  test("a re-block at a new time changes it", () => {
    expect(snapshot([s("a", "waiting", 1)])).not.toBe(snapshot([s("a", "waiting", 2)]));
  });

  test("nothing changing leaves it identical, so we do not redraw on every tick", () => {
    const a = [s("a", "busy"), s("b", "idle")];
    expect(snapshot(a)).toBe(snapshot([...a].reverse()));
  });
});
