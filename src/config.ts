/** Optional `~/.agentview/config.json`. Read if it exists, ignored if it does not.
 *
 *  The defaults are a guess and the plan says so. The right numbers come from a
 *  week of your own use, and you should not have to edit source to find them. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DIR } from "./state.ts";
import { LADDER, SEC, MIN, HOUR } from "./ladder.ts";
import type { Config } from "./types.ts";

export const CONFIG_PATH = join(DIR, "config.json");

/** "30s" | "5m" | "2h" | "1d" -> milliseconds. Returns null on anything else. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(text).trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: SEC, m: MIN, h: HOUR, d: 24 * HOUR }[m[2] as "s" | "m" | "h" | "d"]!;
  return n * unit;
}

export interface LoadedConfig {
  config: Config;
  source: "defaults" | "file";
  warnings: string[];
}

export function fromObject(raw: any, base: Config): LoadedConfig {
  const warnings: string[] = [];
  let ladderMs = base.ladderMs;
  let pollMs = base.pollMs;

  if (Array.isArray(raw?.ladder)) {
    const parsed = raw.ladder.map((x: unknown) => parseDuration(String(x)));
    if (parsed.some((p: number | null) => p === null)) {
      warnings.push(`config: unreadable entry in "ladder" — using defaults for it`);
    } else if (parsed.length === 0) {
      warnings.push(`config: "ladder" is empty — using defaults`);
    } else {
      const sorted = [...(parsed as number[])].sort((a, b) => a - b);
      if (sorted.join() !== (parsed as number[]).join()) {
        warnings.push(`config: "ladder" was out of order — sorted it for you`);
      }
      ladderMs = sorted;
    }
  }

  if (raw?.poll !== undefined) {
    const p = parseDuration(String(raw.poll));
    if (p === null) warnings.push(`config: unreadable "poll" — keeping ${pollMs}ms`);
    else pollMs = Math.max(1000, p);
  }

  // A first rung shorter than the poll interval can never fire on time.
  if (ladderMs[0] !== undefined && ladderMs[0] > 0 && ladderMs[0] < pollMs) {
    warnings.push(
      `config: first rung is shorter than the poll interval — tightening poll to ${ladderMs[0]}ms`
    );
    pollMs = Math.max(1000, ladderMs[0]);
  }

  return { config: { ...base, ladderMs, pollMs }, source: "file", warnings };
}

export async function loadConfig(base: Config, path = CONFIG_PATH): Promise<LoadedConfig> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return fromObject(raw, base);
  } catch {
    return { config: base, source: "defaults", warnings: [] };
  }
}

export function describe(cfg: Config): string {
  const rungs = cfg.ladderMs
    .map((ms) => (ms < MIN ? `${Math.round(ms / SEC)}s` : ms < HOUR ? `${Math.round(ms / MIN)}m` : `${Math.round(ms / HOUR)}h`))
    .join(" · ");
  return `${rungs}  (then silent) · checking every ${Math.round(cfg.pollMs / 1000)}s`;
}

export const DEFAULT_LADDER = LADDER;
