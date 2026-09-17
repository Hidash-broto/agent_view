/** The daemon loop. Deliberately tiny — all the judgment lives in tick(). */

import { appendFile } from "node:fs/promises";
import { readSessions, resetProcCache } from "./sessions.ts";
import { loadState, saveState, ensureDir, LOG_PATH } from "./state.ts";
import { loadSnoozes } from "./snoozes.ts";
import { tick, DEFAULT_CONFIG } from "./tick.ts";
import { osascriptNotifier, type Notifier } from "./notify.ts";
import * as ui from "./ui.ts";
import { loadConfig, describe as describeConfig } from "./config.ts";
import { contextFor, resetContextCache } from "./context.ts";
import type { SessionContext } from "./context.ts";
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
  onCycle?: (info: { now: number; blocked: number; sent: number; wrote: boolean }) => void;
  /** Print live status to stdout. A daemon that prints nothing is
   *  indistinguishable from a daemon that has crashed. */
  print?: (line: string) => void;
}

/** Fingerprint of EVERY session, not just the blocked ones.
 *
 *  This used to filter to status === "waiting", which meant a session starting,
 *  a session ending, or any busy/idle change produced no redraw — the screen sat
 *  stale until the 10-minute heartbeat, still claiming a session count that could
 *  be hours out of date. */
function snapshot(sessions: { status: string; sessionId: string; blockedSince: number }[]): string {
  return sessions
    .map((s) => `${s.sessionId}:${s.status}:${s.blockedSince}`)
    .sort()
    .join("|");
}

/** Sleep, but wake early if the user presses a key. */
function interruptibleSleep(ms: number, signal: { wake: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal.wake = null; resolve(); }, ms);
    signal.wake = () => { clearTimeout(t); signal.wake = null; resolve(); };
  });
}

export async function watch(opts: WatchOpts = {}): Promise<void> {
  const loaded = opts.config ? null : await loadConfig(DEFAULT_CONFIG);
  const config = opts.config ?? loaded!.config;
  const notify = opts.notifier ?? osascriptNotifier;
  const print = opts.print ?? ((l: string) => console.log(l));
  let iterations = 0;
  let degradedLogged = false;
  let lastSnapshot: string | null = null;
  let first = true;
  let lastHeartbeat = 0;
  const HEARTBEAT_MS = 10 * 60_000;

  await log(`watch started (poll ${config.pollMs}ms, ladder ${describeConfig(config)})`);
  for (const w of loaded?.warnings ?? []) { print(`  ${w}`); await log(w); }
  const raw = Boolean(process.stdin.isTTY) && !opts.maxIterations;
  const stop = () => {
    if (raw) { try { process.stdin.setRawMode(false); } catch { /* already restored */ } }
    ui.clearStatus();
    console.log("\n  stopped.\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // `r` re-reads everything from disk; `q` quits. Raw mode means Ctrl-C no longer
  // arrives as SIGINT, so \x03 is handled by hand.
  const sleeper: { wake: (() => void) | null } = { wake: null };
  let forceRefresh = false;
  if (raw) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (buf: Buffer) => {
        const k = buf.toString();
        if (k === "\x03" || k === "q" || k === "Q") return stop();
        if (k === "r" || k === "R") {
          forceRefresh = true;
          resetProcCache();
          resetContextCache();
          sleeper.wake?.();
        }
      });
    } catch {
      /* not a real tty after all; the loop still works, just without keys */
    }
  }

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
      ui.clearStatus();
      print(ui.notifiedLine(now, n.title));
      await log(`notify rung=${n.rung} ${ok ? "posted" : "FAILED"}: ${n.title}`);
    }
    for (const l of out.logLines) await log(l);

    const wrote = await saveState(out.nextState);

    // Show your work. Print on first tick, on any change to the blocked set, and
    // on a slow heartbeat so a quiet machine still proves the daemon is alive.
    const blockedList = sessions.filter((s) => s.status === "waiting");
    const snap = snapshot(sessions);
    const changed = snap !== lastSnapshot;
    const heartbeatDue = now - lastHeartbeat >= HEARTBEAT_MS;

    if (first) {
      ui.clearStatus();
      for (const l of ui.header(sessions, config.ladderMs)) print(l);
    }
    if (changed || heartbeatDue || first || forceRefresh) {
      ui.clearStatus();
      // Every session, not just blocked ones, because the model belongs on every
      // row. Cached on (mtime, size), so this is one read per session per change.
      const ctx = new Map<string, SessionContext>();
      for (const s of sessions) ctx.set(s.sessionId, await contextFor(s.sessionId));
      const frame = blockedList.length
        ? ui.alertFrame(blockedList, now, sessions, ctx)
        : ui.calmFrame(sessions, now, ctx);
      for (const l of frame) print(l);
      lastSnapshot = snap;
      lastHeartbeat = now;
      first = false;
      forceRefresh = false;
    }
    ui.writeStatus(ui.statusText(now, sessions.length, blockedList.length, config.pollMs, raw));

    const blocked = blockedList.length;
    opts.onCycle?.({ now, blocked, sent, wrote });

    iterations++;
    if (opts.maxIterations && iterations >= opts.maxIterations) {
      if (raw) { try { process.stdin.setRawMode(false); } catch { /* noop */ } }
      return;
    }
    await interruptibleSleep(config.pollMs, sleeper);
  }
}
