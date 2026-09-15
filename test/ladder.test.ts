import { describe, expect, test } from "bun:test";
import { dueAt, highestDueRung, isExhausted, elapsed, LADDER, MAX_RUNG, MIN, HOUR } from "../src/ladder.ts";
import { humanize, absoluteTime } from "../src/format.ts";

const T0 = 1_700_000_000_000;

describe("ladder", () => {
  test("T20 dueAt is independent of now — same input, same output, forever", () => {
    // This is what makes the ladder survive a daemon restart unchanged. Anchoring
    // to "when we last notified" instead would drift on every restart.
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const a = dueAt(T0, rung);
      const b = dueAt(T0, rung);
      expect(a).toBe(b);
      expect(a).toBe(T0 + LADDER[rung]!);
    }
  });

  test("T21 rung boundaries", () => {
    expect(highestDueRung(T0, T0)).toBe(-1);
    expect(highestDueRung(T0, T0 + 30 * MIN - 1)).toBe(-1);
    expect(highestDueRung(T0, T0 + 30 * MIN)).toBe(0);
    expect(highestDueRung(T0, T0 + 2 * HOUR)).toBe(1);
    expect(highestDueRung(T0, T0 + 8 * HOUR)).toBe(2);
    expect(highestDueRung(T0, T0 + 24 * HOUR)).toBe(3);
    expect(highestDueRung(T0, T0 + 48 * HOUR)).toBe(4);
  });

  test("the top rung is a ceiling: 30 days is still rung 4", () => {
    expect(highestDueRung(T0, T0 + 30 * 24 * HOUR)).toBe(MAX_RUNG);
    expect(isExhausted(MAX_RUNG)).toBe(true);
    expect(isExhausted(MAX_RUNG - 1)).toBe(false);
  });

  test("elapsed never goes negative when the clock steps backwards", () => {
    expect(elapsed(T0 + HOUR, T0)).toBe(0);
    expect(elapsed(T0, T0 + HOUR)).toBe(HOUR);
  });

  test("a custom ladder is honoured (config escape hatch is already possible)", () => {
    const tiny = [MIN, 5 * MIN];
    expect(highestDueRung(T0, T0 + 6 * MIN, tiny)).toBe(1);
    expect(isExhausted(1, tiny)).toBe(true);
  });
});

describe("humanize", () => {
  test("T22 boundaries, including negatives", () => {
    expect(humanize(-5 * HOUR)).toBe("now");
    expect(humanize(0)).toBe("now");
    expect(humanize(59_000)).toBe("now");
    expect(humanize(60_000)).toBe("1m");
    expect(humanize(59 * MIN)).toBe("59m");
    expect(humanize(60 * MIN)).toBe("1h");
    expect(humanize(2 * HOUR)).toBe("2h");
    expect(humanize(23 * HOUR + 59 * MIN)).toBe("23h");
    expect(humanize(24 * HOUR)).toBe("24h");
    expect(humanize(1610 * MIN)).toBe("26h");
  });

  test("hours keep counting past a day — 72h lands harder than 3d for neglect", () => {
    expect(humanize(72 * HOUR)).toBe("72h");
  });

  test("absoluteTime shows a weekday once the block is not from today", () => {
    const today = absoluteTime(T0, T0);
    expect(today).toMatch(/^\d{2}:\d{2}$/);
    const earlier = absoluteTime(T0 - 48 * HOUR, T0);
    expect(earlier).toMatch(/^\w{3} \d{2}:\d{2}$/);
  });
});
