import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, resetWriteCache } from "../src/state.ts";
import { addSnooze, loadSnoozes, removeSnooze, prune } from "../src/snoozes.ts";
import { stateKey } from "../src/types.ts";
import type { Session, State } from "../src/types.ts";
import { HOUR } from "../src/ladder.ts";

const T0 = 1_700_000_000_000;
let dir = "";
const paths = () => ({ state: join(dir, "state.json"), bak: join(dir, "state.json.bak") });

const blocked: Session = {
  sessionId: "aaaa-1111", pid: 1, name: "erp-00", nameSource: "derived",
  cwd: "/Users/x/acme/erp", status: "waiting", waitingFor: "input needed",
  blockedSince: T0, startedAt: T0, durationKnown: true,
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "agentview-state-")); resetWriteCache(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("state durability", () => {
  test("T10 writes are atomic: no .tmp is left behind and the file parses", async () => {
    const s: State = { [stateKey("a", T0)]: { sessionId: "a", blockedSince: T0, lastRung: 2, lastNotifiedAt: T0, lastSeenAt: T0 } };
    await saveState(s, paths());
    const parsed = JSON.parse(await readFile(paths().state, "utf8"));
    expect(parsed[stateKey("a", T0)].lastRung).toBe(2);
    await expect(readFile(`${paths().state}.tmp`, "utf8")).rejects.toThrow();
  });

  test("T8 a corrupt state file recovers from .bak before considering a reset", async () => {
    const good: State = { [stateKey("a", T0)]: { sessionId: "a", blockedSince: T0, lastRung: 3, lastNotifiedAt: T0, lastSeenAt: T0 } };
    await saveState(good, paths());
    // A second, genuinely different write is what rolls the previous one into .bak.
    // (An identical write is skipped now — see the dedupe test below.)
    await saveState({ ...good, [stateKey("b", T0)]: { sessionId: "b", blockedSince: T0, lastRung: 0, lastNotifiedAt: T0, lastSeenAt: T0 } }, paths());
    await writeFile(paths().state, "{{{ corrupt");

    const { state, recovery } = await loadState([blocked], T0 + HOUR, paths());
    expect(recovery).toBe("bak");
    expect(state[stateKey("a", T0)]!.lastRung).toBe(3);
  });

  test("T7 unrecoverable state SEEDS from current blocks — it never blanks", async () => {
    // Blanking would re-fire every blocked session at its highest rung on the very
    // next tick: a crash would produce the notification storm the design exists to
    // prevent. Degrade quiet, never loud.
    await writeFile(paths().state, "{{{ corrupt");
    const { state, recovery } = await loadState([blocked], T0 + 26 * HOUR, paths());

    expect(recovery).toBe("seeded");
    const entry = state[stateKey(blocked.sessionId, blocked.blockedSince)]!;
    expect(entry.lastRung).toBeGreaterThanOrEqual(3);
  });

  test("an unchanged state is not rewritten — no fsync, no SSD flush", async () => {
    // At a 5s poll this is ~17,000 writes a day that would otherwise be identical.
    const s: State = { [stateKey("a", T0)]: { sessionId: "a", blockedSince: T0, lastRung: 1, lastNotifiedAt: T0, lastSeenAt: T0 } };
    expect(await saveState(s, paths())).toBe(true);
    expect(await saveState(s, paths())).toBe(false);
    expect(await saveState({ ...s }, paths())).toBe(false);   // structurally identical
    expect(await saveState({}, paths())).toBe(true);          // genuinely different
  });

  test("a missing state file is 'empty', not an error and not a seed", async () => {
    const { state, recovery } = await loadState([blocked], T0, paths());
    expect(recovery).toBe("empty");
    expect(state).toEqual({});
  });

  test("a state file holding a JSON array (not an object) is treated as corrupt", async () => {
    await writeFile(paths().state, "[1,2,3]");
    const { recovery } = await loadState([], T0, paths());
    expect(recovery).toBe("seeded");
  });
});

describe("snoozes are a separate single-writer file", () => {
  const sp = () => join(dir, "snoozes.json");

  test("T9 a snooze written mid-tick survives, because the daemon never writes this file", async () => {
    // The race the two-file split removes: daemon read-modify-writes state.json
    // across a whole tick while the user snoozes in response to the notification
    // that tick just emitted.
    await saveState({ [stateKey("a", T0)]: { sessionId: "a", blockedSince: T0, lastRung: 0, lastNotifiedAt: T0, lastSeenAt: T0 } }, paths());
    await addSnooze({ sessionId: "aaaa-1111", blockedSince: T0, until: T0 + 4 * HOUR }, T0, sp());
    await saveState({ [stateKey("a", T0)]: { sessionId: "a", blockedSince: T0, lastRung: 1, lastNotifiedAt: T0, lastSeenAt: T0 } }, paths());

    const after = await loadSnoozes(sp());
    expect(after).toHaveLength(1);
    expect(after[0]!.until).toBe(T0 + 4 * HOUR);
  });

  test("an ack has no expiry and is scoped to one block", async () => {
    await addSnooze({ sessionId: "aaaa-1111", blockedSince: T0, until: null }, T0, sp());
    const list = await loadSnoozes(sp());
    expect(list[0]!.until).toBeNull();
    expect(list[0]!.blockedSince).toBe(T0);
  });

  test("adding a snooze for the same block replaces rather than duplicates", async () => {
    await addSnooze({ sessionId: "a", blockedSince: T0, until: T0 + HOUR }, T0, sp());
    await addSnooze({ sessionId: "a", blockedSince: T0, until: T0 + 8 * HOUR }, T0, sp());
    const list = await loadSnoozes(sp());
    expect(list).toHaveLength(1);
    expect(list[0]!.until).toBe(T0 + 8 * HOUR);
  });

  test("expired snoozes are dropped on write; acks for vanished blocks are pruned", async () => {
    await addSnooze({ sessionId: "old", blockedSince: T0, until: T0 + HOUR }, T0, sp());
    await addSnooze({ sessionId: "new", blockedSince: T0, until: T0 + 10 * HOUR }, T0 + 2 * HOUR, sp());
    expect((await loadSnoozes(sp())).map((s) => s.sessionId)).toEqual(["new"]);

    const acks = [{ sessionId: "gone", blockedSince: T0, until: null }];
    expect(prune(acks, T0, new Set())).toHaveLength(0);
    expect(prune(acks, T0, new Set([`gone:${T0}`]))).toHaveLength(1);
  });

  test("a corrupt snoozes file reads as no snoozes rather than throwing", async () => {
    await writeFile(sp(), "not json");
    expect(await loadSnoozes(sp())).toEqual([]);
  });

  test("unsnooze removes every entry for a session and reports the count", async () => {
    await addSnooze({ sessionId: "a", blockedSince: T0, until: T0 + HOUR }, T0, sp());
    await addSnooze({ sessionId: "b", blockedSince: T0, until: T0 + HOUR }, T0, sp());
    expect(await removeSnooze("a", sp())).toBe(1);
    expect((await loadSnoozes(sp())).map((s) => s.sessionId)).toEqual(["b"]);
  });
});
