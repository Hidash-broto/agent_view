/** The daemon loop. Deliberately tiny — all the judgment lives in tick(). */

import { appendFile } from "node:fs/promises";
import { readSessions } from "./sessions.ts";
import { loadState, saveState, ensureDir, LOG_PATH } from "./state.ts";
import { loadSnoozes } from "./snoozes.ts";
import { tick, DEFAULT_CONFIG } from "./tick.ts";
import { osascriptNotifier, type Notifier } from "./notify.ts";
import type { Config } from "./types.ts";

async function log(line: string): Promise<void> {
  const stamped = `${new Date().toISOString()}  ${line}\n`;
  try {
    await ensureDir();
    await appendFile(LOG_PATH, stamped);
  } catch {
    /* logging must never take the daemon down */
  }
}

export interface WatchOpts {
  config?: Config;
  notifier?: Notifier;
  /** Test hook: stop after N iterations instead of running forever. */
  maxIterations?: number;
  onCycle?: (info: { now: number; blocked: number; sent: number }) => void;
}

export async function watch(opts: WatchOpts = {}): Promise<void> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const notify = opts.notifier ?? osascriptNotifier;
  let iterations = 0;
  let degradedLogged = false;

  await log(`watch started (poll ${config.pollMs}ms, ${config.ladderMs.length} rungs)`);

  for (;;) {
    // Recompute everything from the wall clock every tick. NEVER schedule a
    // setTimeout past one interval: monotonic timers sleep through system sleep
    // and would deliver an 8-hour-old reminder 8 waking-hours late.
    const now = Date.now();

    const { sessions, degraded } = await readSessions({
      onLog: (l) => { if (!degradedLogged) { void log(l); degradedLogged = true; } },
    });
    if (degraded && !degradedLogged) {
      await log("degraded: durations unavailable");
      degradedLogged = true;
    }

    const { state, recovery } = await loadState(sessions, now);
    if (recovery === "bak") await log("state.json was unreadable — recovered from .bak");
    if (recovery === "seeded") {
      await log("state lost — seeded from current blocks (one notification skipped, no storm)");
    }

    const snoozes = await loadSnoozes();
    const out = tick({ now, sessions, state, snoozes, config });

    let sent = 0;
    for (const n of out.notifications) {
      const ok = await notify(n);
      if (ok) sent++;
      await log(`notify rung=${n.rung} ${ok ? "posted" : "FAILED"}: ${n.title}`);
    }
    for (const l of out.logLines) await log(l);

    await saveState(out.nextState);

    const blocked = sessions.filter((s) => s.status === "waiting").length;
    opts.onCycle?.({ now, blocked, sent });

    iterations++;
    if (opts.maxIterations && iterations >= opts.maxIterations) return;
    await Bun.sleep(config.pollMs);
  }
}
