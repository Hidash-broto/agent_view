import { describe, expect, test } from "bun:test";
import { ackHint, calmFrame, alertFrame, header, statusText } from "../src/ui.ts";
import { HOUR } from "../src/ladder.ts";
import type { Session } from "../src/types.ts";

const T0 = 1_700_000_000_000;
const mk = (name: string, status: Session["status"], hoursAgo: number, id = name): Session => ({
  sessionId: id, pid: 1, name, nameSource: "derived", cwd: "/Users/x/acme/erp",
  status, waitingFor: "input needed", blockedSince: T0 - hoursAgo * HOUR,
  startedAt: T0, durationKnown: true,
});

describe("ackHint — the suggested command has to actually work when pasted", () => {
  test("uses the shortest prefix that is unambiguous", () => {
    const all = [mk("erp-00", "waiting", 26), mk("billing-a3", "idle", 1)];
    expect(ackHint(all[0]!, all)).toBe("erp");
  });

  test("lengthens the prefix when a sibling collides", () => {
    // erp-00 and erp-0e differ by one character and one of them is the blocked one.
    const all = [mk("erp-00", "waiting", 26), mk("erp-0e", "idle", 3)];
    expect(ackHint(all[0]!, all)).toBe("erp-00");
  });

  test("quotes a prefix containing spaces so the shell does not split it", () => {
    const all = [mk("Parallel agents implementation", "waiting", 1), mk("Parallel jobs", "idle", 1)];
    const hint = ackHint(all[0]!, all);
    expect(hint.startsWith('"')).toBe(true);
    expect(hint.endsWith('"')).toBe(true);
    expect(hint).toContain("Parallel a");
  });

  test("falls back to the full (quoted) name when nothing else disambiguates", () => {
    const a = mk("same name", "waiting", 1, "id-a");
    const b = mk("same name", "idle", 1, "id-b");
    expect(ackHint(a, [a, b])).toBe('"same name"');
  });
});

describe("frames", () => {
  const sessions = [mk("erp-00", "busy", 0), mk("erp-76", "idle", 65), mk("billing-a3", "idle", 2)];

  test("the header states what will happen, in plain words", () => {
    const h = header(sessions).join("\n");
    expect(h).toContain("Watching 3 Claude sessions");
    expect(h).toContain("30s");   // the fast first ping
    expect(h).toContain("24h");
  });

  test("the calm frame says nothing is waiting and marks the longest idle", () => {
    const f = calmFrame(sessions, T0).join("\n");
    expect(f).toContain("Nothing is waiting on you");
    expect(f).toContain("working");
    expect(f).toContain("← longest");
    expect(f).toContain("65h");
  });

  test("the alert frame names the count, the wait, and a runnable command", () => {
    const blocked = [mk("erp-00", "waiting", 26)];
    const f = alertFrame(blocked, T0, sessions).join("\n");
    expect(f).toContain("1 SESSION WAITING FOR YOU");
    expect(f).toContain("waiting 26h");
    expect(f).toContain("agentview ack erp");
  });

  test("the alert frame pluralises correctly", () => {
    const two = [mk("a-1", "waiting", 3), mk("b-2", "waiting", 1)];
    expect(alertFrame(two, T0, two).join("\n")).toContain("2 SESSIONS WAITING");
  });

  test("the status line reports all-clear vs a count", () => {
    expect(statusText(T0, 5, 0, 5000)).toContain("all clear");
    expect(statusText(T0, 5, 2, 5000)).toContain("2 waiting");
    expect(statusText(T0, 5, 0, 5000)).toContain("Ctrl-C to stop");
  });
});
