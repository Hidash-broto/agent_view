/** state.json — the DAEMON is the only writer. The CLI only reads it.
 *  snoozes.json (separate file) is the only thing the CLI writes. Two single-writer
 *  files means no lock, no read-modify-write race, and no way for a snooze issued
 *  mid-tick to be erased by the daemon's write. */

import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, State } from "./types.ts";
import { seedFrom } from "./tick.ts";

export const DIR = join(homedir(), ".agentview");
export const STATE_PATH = join(DIR, "state.json");
export const BAK_PATH = join(DIR, "state.json.bak");
export const LOG_PATH = join(DIR, "agentview.log");

export type Recovery = "ok" | "empty" | "bak" | "seeded";

export async function ensureDir(dir = DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function parseOrNull(path: string): Promise<State | null> {
  try {
    const o = JSON.parse(await readFile(path, "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as State) : null;
  } catch {
    return null;
  }
}

/**
 * Loading must never produce a notification storm.
 *
 * The naive recovery ("corrupt → reset to empty, log, continue") discards every
 * lastRung, so the very next tick re-fires every currently blocked session at its
 * highest crossed rung. A crash would produce exactly the burst the whole design
 * is built to avoid. So: try the backup, and if that fails too, SEED from the
 * current sessions rather than blanking. Costs one missed notification per
 * session; never costs a storm.
 */
export async function loadState(
  liveSessions: Session[],
  now: number,
  paths = { state: STATE_PATH, bak: BAK_PATH }
): Promise<{ state: State; recovery: Recovery }> {
  const primary = await parseOrNull(paths.state);
  if (primary) return { state: primary, recovery: "ok" };

  try {
    await readFile(paths.state, "utf8");
  } catch {
    return { state: {}, recovery: "empty" }; // no file at all: first run, nothing to lose
  }

  const bak = await parseOrNull(paths.bak);
  if (bak) return { state: bak, recovery: "bak" };

  return { state: seedFrom(liveSessions, now), recovery: "seeded" };
}

/** tmp → fsync → rename. Atomic on APFS: a reader sees the old file or the new one,
 *  never a torn one, and power loss mid-write leaves the previous good file. */
export async function saveState(
  state: State,
  paths = { state: STATE_PATH, bak: BAK_PATH }
): Promise<void> {
  await ensureDir(join(paths.state, ".."));
  const tmp = `${paths.state}.tmp`;
  try {
    await copyFile(paths.state, paths.bak);
  } catch {
    /* first write, nothing to back up */
  }
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(state, null, 0));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, paths.state);
}

export async function clearState(paths = { state: STATE_PATH, bak: BAK_PATH }): Promise<void> {
  for (const p of [paths.state, paths.bak, `${paths.state}.tmp`]) {
    try { await unlink(p); } catch { /* already gone */ }
  }
}
