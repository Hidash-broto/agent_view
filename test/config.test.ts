import { describe, expect, test } from "bun:test";
import { parseDuration, fromObject, describe as describeCfg } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/tick.ts";
import { SEC, MIN, HOUR } from "../src/ladder.ts";

describe("config", () => {
  test("parses the durations a human would actually type", () => {
    expect(parseDuration("30s")).toBe(30 * SEC);
    expect(parseDuration("5m")).toBe(5 * MIN);
    expect(parseDuration("2h")).toBe(2 * HOUR);
    expect(parseDuration("1d")).toBe(24 * HOUR);
    expect(parseDuration(" 45 m ")).toBe(45 * MIN);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  test("a custom ladder replaces the default", () => {
    const { config } = fromObject({ ladder: ["10s", "1m", "1h"] }, DEFAULT_CONFIG);
    expect(config.ladderMs).toEqual([10 * SEC, 60 * SEC, HOUR]);
  });

  test("an out-of-order ladder is sorted, with a warning rather than a failure", () => {
    const { config, warnings } = fromObject({ ladder: ["2h", "30s", "10m"] }, DEFAULT_CONFIG);
    expect(config.ladderMs).toEqual([30 * SEC, 10 * MIN, 2 * HOUR]);
    expect(warnings.join(" ")).toMatch(/out of order/);
  });

  test("a first rung faster than the poll interval tightens the poll", () => {
    // Otherwise the rung can never fire on time and the tool silently under-delivers.
    const { config, warnings } = fromObject({ ladder: ["2s", "1h"], poll: "30s" }, DEFAULT_CONFIG);
    expect(config.pollMs).toBeLessThanOrEqual(2 * SEC);
    expect(warnings.join(" ")).toMatch(/poll/);
  });

  test("garbage is ignored and the defaults survive", () => {
    const { config, warnings } = fromObject({ ladder: ["nope"], poll: "whenever" }, DEFAULT_CONFIG);
    expect(config.ladderMs).toEqual(DEFAULT_CONFIG.ladderMs);
    expect(config.pollMs).toBe(DEFAULT_CONFIG.pollMs);
    expect(warnings).toHaveLength(2);
  });

  test("an empty object changes nothing", () => {
    const { config } = fromObject({}, DEFAULT_CONFIG);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("describe renders the ladder the way the header shows it", () => {
    expect(describeCfg(DEFAULT_CONFIG)).toContain("30s");
    expect(describeCfg(DEFAULT_CONFIG)).toContain("then silent");
  });
});
