/** snoozes.json — the CLI is the only writer. The daemon only reads it.
 *
 *  `snooze` sets `until` (temporary). `ack` sets `until: null`, scoped to one
 *  block via blockedSince — "I handled this, never mention it again", while a
 *  genuinely new question in the same session still notifies.
 *
 *  ack is the escape hatch that depends on nothing Claude Code does. If its
 *  `status` field ever fails to leave "waiting", this is how the user wins. */

import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DIR, ensureDir } from "./state.ts";
import type { Snooze } from "./types.ts";

export const SNOOZE_PATH = join(DIR, "snoozes.json");

export async function loadSnoozes(path = SNOOZE_PATH): Promise<Snooze[]> {
  try {
    const o = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(o) ? (o as Snooze[]) : [];
  } catch {
    return []; // absent or corrupt: no snoozes. Failing open here is loud, not silent.
  }
}

async function write(list: Snooze[], path: string): Promise<void> {
  await ensureDir(join(path, ".."));
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(list, null, 0));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

/** Drop expired temporary snoozes, and acks whose block is no longer present. */
export function prune(list: Snooze[], now: number, liveBlocks: Set<string>): Snooze[] {
  return list.filter((s) =>
    s.until === null ? liveBlocks.has(`${s.sessionId}:${s.blockedSince}`) : s.until > now
  );
}

export async function addSnooze(
  entry: Snooze,
  now: number,
  path = SNOOZE_PATH
): Promise<void> {
  const list = await loadSnoozes(path);
  const kept = list.filter(
    (s) => !(s.sessionId === entry.sessionId && s.blockedSince === entry.blockedSince)
  );
  kept.push(entry);
  await write(kept.filter((s) => s.until === null || s.until > now), path);
}

export async function removeSnooze(sessionId: string, path = SNOOZE_PATH): Promise<number> {
  const list = await loadSnoozes(path);
  const kept = list.filter((s) => s.sessionId !== sessionId);
  await write(kept, path);
  return list.length - kept.length;
}
