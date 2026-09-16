import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStateFiles, readSessions, blockedOf, aliveDefault, parseProcStartUtc } from "../src/sessions.ts";
import type { ProcInfo } from "../src/sessions.ts";

let dir = "";
const T0 = 1_700_000_000_000;

function raw(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    pid: process.pid,
    sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
    cwd: "/Users/x/acme/erp",
    name: "erp-00",
    nameSource: "derived",
    status: "waiting",
    waitingFor: "input needed",
    startedAt: T0,
    statusUpdatedAt: T0,
    ...over,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentview-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("safety", () => {
  test("T12 never lists a .key file", async () => {
    // The real directory is drwx------ and holds credentials at 0600 interleaved
    // with the JSON. Listing them at all is the thing to avoid.
    await writeFile(join(dir, "123.json"), raw());
    await writeFile(join(dir, "123.abc123.key"), "SECRET");
    await chmod(join(dir, "123.abc123.key"), 0o600);
    await writeFile(join(dir, "999.def.key"), "SECRET");

    const files = await listStateFiles(dir);

    expect(files).toHaveLength(1);
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".key"))).toBe(false);
  });
});

describe("liveness and pid reuse", () => {
  test("T15 a dead pid is excluded even though its file exists", async () => {
    await writeFile(join(dir, "424242.json"), raw({ pid: 424242 }));
    const { sessions } = await readSessions({ dir, alive: () => false, procs: null });
    expect(sessions).toHaveLength(0);
  });

  test("T13 a recycled pid is dropped — and the check is timezone-independent", async () => {
    // procStart in these files is UTC formatted as a local-looking string, so
    // comparing it to `ps lstart` mismatches by the machine's TZ offset on every
    // session. We compare startedAt (epoch ms) instead, which has no such trap.
    return (async () => {
      await writeFile(join(dir, "5555.json"), raw({ pid: 5555, startedAt: T0, procStart: undefined }));
      // Wide tolerance: startedAt measures the session, not the process, so a small
      // gap proves nothing either way. Only an implausible gap is treated as reuse.
      const near = new Map<number, ProcInfo>([[5555, { startEpoch: T0 + 60_000, comm: "claude" }]]);
      const wild = new Map<number, ProcInfo>([[5555, { startEpoch: T0 + 8 * 3600_000, comm: "claude" }]]);
      expect((await readSessions({ dir, alive: () => true, procs: near })).sessions).toHaveLength(1);
      expect((await readSessions({ dir, alive: () => true, procs: wild })).sessions).toHaveLength(0);
    })();
  });

  test("a live pid running something other than claude is dropped", async () => {
    await writeFile(join(dir, "6666.json"), raw({ pid: 6666, startedAt: T0 }));
    const procs = new Map<number, ProcInfo>([[6666, { startEpoch: T0, comm: "/usr/bin/python3" }]]);
    const { sessions } = await readSessions({ dir, alive: () => true, procs });
    expect(sessions).toHaveLength(0);
  });

  test("aliveDefault reports true for our own pid and false for an absurd one", () => {
    expect(aliveDefault(process.pid)).toBe(true);
    expect(aliveDefault(999_999)).toBe(false);
  });
});

describe("degradation", () => {
  test("T16 missing statusUpdatedAt gives durationKnown:false and no fabricated time", async () => {
    await writeFile(join(dir, "1.json"), raw({ statusUpdatedAt: undefined }));
    const { sessions } = await readSessions({ dir, alive: () => true, procs: null });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationKnown).toBe(false);
    expect(sessions[0]!.blockedSince).toBe(0);
  });

  test("T18 one malformed file does not prevent reading the others", async () => {
    await writeFile(join(dir, "1.json"), raw({ sessionId: "good-session" }));
    await writeFile(join(dir, "2.json"), "{ truncated mid-obj");
    const logs: string[] = [];
    const { sessions } = await readSessions({ dir, alive: () => true, procs: null, onLog: (l) => logs.push(l) });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe("good-session");
    expect(logs.join(" ")).toMatch(/unreadable/);
  });

  test("T17 an empty dir falls back to the CLI, degraded, with no durations", async () => {
    const { sessions, degraded } = await readSessions({
      dir,
      alive: () => true,
      procs: null,
      cliFallback: async () => [
        { sessionId: "cli-1", pid: process.pid, cwd: "/tmp/x", name: "x-01", status: "waiting" },
      ],
    });
    expect(degraded).toBe(true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationKnown).toBe(false);
  });

  test("no state dir AND no CLI is empty, not a crash", async () => {
    const { sessions, degraded } = await readSessions({
      dir: join(dir, "nope"),
      cliFallback: async () => null,
    });
    expect(sessions).toEqual([]);
    expect(degraded).toBe(true);
  });
});

describe("ordering", () => {
  test("T19 blocked sorts by longest wait first, ties broken by sessionId", () => {
    const mk = (id: string, since: number) => ({
      sessionId: id, pid: 1, name: id, nameSource: "derived", kind: "interactive" as const, cwd: "/a/b",
      status: "waiting" as const, blockedSince: since, startedAt: 0, durationKnown: true,
    });
    const out = blockedOf([mk("bbb", T0 + 100), mk("aaa", T0), mk("ccc", T0)]);
    expect(out.map((s) => s.sessionId)).toEqual(["aaa", "ccc", "bbb"]);
  });

  test("non-waiting sessions are not in the blocked list", () => {
    const mk = (st: "busy" | "idle" | "waiting") => ({
      sessionId: st, pid: 1, name: st, nameSource: "derived", kind: "interactive" as const, cwd: "/a/b",
      status: st, blockedSince: T0, startedAt: 0, durationKnown: true,
    });
    expect(blockedOf([mk("busy"), mk("idle"), mk("waiting")]).map((s) => s.status)).toEqual(["waiting"]);
  });
});

describe("parseProcStartUtc", () => {
  test("parses the ps-style stamp as UTC, not local", () => {
    expect(parseProcStartUtc("Wed Sep 16 04:51:49 2026")).toBe(Date.UTC(2026, 8, 16, 4, 51, 49));
  });
  test("tolerates the padding ps emits for single-digit days", () => {
    expect(parseProcStartUtc("Mon Sep  7 10:19:51 2026")).toBe(Date.UTC(2026, 8, 7, 10, 19, 51));
  });
  test("returns null on anything it does not recognise", () => {
    expect(parseProcStartUtc("yesterday")).toBeNull();
    expect(parseProcStartUtc("Wed Xyz 16 04:51:49 2026")).toBeNull();
    expect(parseProcStartUtc("")).toBeNull();
  });
});
