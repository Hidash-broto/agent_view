import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Status } from "./types.ts";

/** Resolve once, in one place. AGENTVIEW_SESSIONS_DIR is the test/override hook;
 *  CLAUDE_CONFIG_DIR is Claude Code's own variable and was previously named in an
 *  error message without ever being read. */
export function resolveSessionsDir(env: Record<string, string | undefined> = process.env): string {
  if (env.AGENTVIEW_SESSIONS_DIR) return env.AGENTVIEW_SESSIONS_DIR;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, "sessions");
  return join(homedir(), ".claude", "sessions");
}

export const DEFAULT_DIR = resolveSessionsDir();

/**
 * SAFETY: this directory is drwx------ and holds *.key files at 0600 interleaved
 * with the JSON. We list *.json and nothing else, ever. The test asserts it.
 */
export async function listStateFiles(dir = DEFAULT_DIR): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((n) => n.endsWith(".json")).map((n) => join(dir, n));
}

export interface ProcInfo {
  startEpoch: number;
  comm: string;
}

/** `procStart` is the PROCESS start time, written in UTC but formatted as a bare
 *  local-looking string ("Wed Sep 16 04:51:49 2026"). Parse it as UTC and it matches
 *  `ps -o lstart=` to the second on every session, interactive or background.
 *
 *  Do NOT use `startedAt` for this. That is the SESSION start time, and for a
 *  background session running on a pre-warmed spare process the two differ by however
 *  long the spare sat in the pool — measured at 34 minutes on a real machine, which
 *  a naive guard reads as "this pid was recycled" and silently drops a live session. */
export function parseProcStartUtc(text: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mo = months.indexOf(m[1]!);
  if (mo < 0) return null;
  return Date.UTC(Number(m[6]), mo, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Liveness without a subprocess. Measured elsewhere at ~100k calls in 44ms. */
export function aliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to someone else — still alive.
    return e?.code === "EPERM";
  }
}

let procCache: { at: number; pids: string; table: Map<number, ProcInfo> } | null = null;
export const PROC_CACHE_MS = 60_000;

export function resetProcCache(): void {
  procCache = null;
}

/** The proc table exists only to catch a recycled pid. That can only change when
 *  the set of pids we care about changes — so spawn `ps` then, or once a minute,
 *  rather than every single tick. A fork+exec every 5s is the other half of this
 *  program's idle cost. */
export async function cachedProcTable(pids: number[], now = Date.now()): Promise<Map<number, ProcInfo>> {
  const key = [...pids].sort((a, b) => a - b).join(",");
  if (procCache && procCache.pids === key && now - procCache.at < PROC_CACHE_MS) {
    return procCache.table;
  }
  const table = await readProcTable();
  procCache = { at: now, pids: key, table };
  return table;
}

/** ONE `ps` per tick, not one per session. Only needed for the reuse guard. */
export async function readProcTable(): Promise<Map<number, ProcInfo>> {
  const out = new Map<number, ProcInfo>();
  try {
    const p = Bun.spawn(["ps", "-eo", "pid=,lstart=,comm="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited; // never leak the fd or the zombie
    for (const line of text.split("\n")) {
      const t = line.trim().split(/\s+/);
      if (t.length < 7) continue;
      const pid = Number(t[0]);
      if (!Number.isFinite(pid)) continue;
      // lstart is 5 tokens: Www Mmm D HH:MM:SS YYYY
      const d = new Date(`${t[2]} ${t[3]} ${t[5]} ${t[4]}`);
      if (Number.isNaN(d.getTime())) continue;
      out.set(pid, { startEpoch: d.getTime(), comm: t.slice(6).join(" ") });
    }
  } catch {
    /* ps unavailable: the reuse guard degrades to liveness-only. */
  }
  return out;
}

export interface ReadOpts {
  dir?: string;
  alive?: (pid: number) => boolean;
  /** null disables the reuse guard (tests, or ps unavailable). */
  procs?: Map<number, ProcInfo> | null;
  onLog?: (line: string) => void;
  /** Injected for tests. Defaults to spawning `claude agents --json`. */
  cliFallback?: () => Promise<any[] | null>;
}

function validate(o: any): boolean {
  return (
    o && typeof o.sessionId === "string" && typeof o.pid === "number" &&
    typeof o.cwd === "string" && typeof o.status === "string"
  );
}

/** Retry once before believing a parse failure: Claude Code writes these files in
 *  place rather than via atomic rename, so a torn read is possible and is NOT
 *  the same thing as the schema having drifted. */
async function readJsonWithRetry(path: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      if (attempt === 0) await Bun.sleep(50);
    }
  }
  return null;
}

export async function claudeAgentsJson(): Promise<any[] | null> {
  try {
    const p = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ReadResult {
  sessions: Session[];
  /** true when we fell back to the CLI and therefore have no durations. */
  degraded: boolean;
}

export async function readSessions(opts: ReadOpts = {}): Promise<ReadResult> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const alive = opts.alive ?? aliveDefault;
  const log = opts.onLog ?? (() => {});
  const files = await listStateFiles(dir);

  if (files.length === 0) {
    const rows = await (opts.cliFallback ?? claudeAgentsJson)();
    if (!rows) return { sessions: [], degraded: true };
    log("state dir unavailable — using `claude agents --json`; durations unavailable");
    return {
      sessions: rows.filter(validate).map((o) => ({
        sessionId: o.sessionId, pid: o.pid, name: o.name ?? o.sessionId.slice(0, 8),
        nameSource: o.nameSource ?? "derived", cwd: o.cwd, status: o.status as Status,
        waitingFor: o.waitingFor, blockedSince: 0, startedAt: o.startedAt ?? 0,
        durationKnown: false,
      })),
      degraded: true,
    };
  }

  // Parse first so we know which pids matter, then consult the (cached) proc table.
  const parsed: any[] = [];
  for (const f of files) {
    const o = await readJsonWithRetry(f);
    if (!o) { log(`unreadable after retry: ${f}`); continue; }
    if (!validate(o)) { log(`shape drift: ${f}`); continue; }
    if (!alive(o.pid)) continue;
    parsed.push(o);
  }

  const procs =
    opts.procs === undefined
      ? await cachedProcTable(parsed.map((o) => o.pid))
      : opts.procs;
  const sessions: Session[] = [];

  for (const o of parsed) {
    // Pid-reuse guard, against the PROCESS start time. procStart when available
    // (exact, and correct for spare-backed background sessions); startedAt only as
    // a fallback, with a wide tolerance because it measures something else.
    if (procs) {
      const p = procs.get(o.pid);
      const procUtc = typeof o.procStart === "string" ? parseProcStartUtc(o.procStart) : null;
      const expected = procUtc ?? (typeof o.startedAt === "number" && o.startedAt > 0 ? o.startedAt : null);
      const tolerance = procUtc !== null ? 5_000 : 60 * 60_000;
      if (p && expected !== null) {
        if (Math.abs(p.startEpoch - expected) > tolerance) {
          log(`pid ${o.pid} was recycled — dropping stale ${o.sessionId.slice(0, 8)}`);
          continue;
        }
        if (p.comm && !p.comm.toLowerCase().includes("claude")) {
          log(`pid ${o.pid} is not claude (${p.comm}) — dropping stale entry`);
          continue;
        }
      }
    }

    // An unclaimed background spare has a session file but has never been used for
    // anything: kind "bg" with no nameSource, and a name that is just its own id.
    // There is nothing to neglect, and `claude agents --json` omits it too.
    if (o.kind === "bg" && !o.nameSource) continue;

    const hasTs = typeof o.statusUpdatedAt === "number" && o.statusUpdatedAt > 0;
    sessions.push({
      sessionId: o.sessionId, pid: o.pid, name: o.name ?? o.sessionId.slice(0, 8),
      nameSource: o.nameSource ?? "derived", cwd: o.cwd, status: o.status as Status,
      kind: o.kind === "bg" ? "background" : "interactive",
      waitingFor: o.waitingFor,
      blockedSince: hasTs ? o.statusUpdatedAt : 0,
      startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
      durationKnown: hasTs,
    });
  }
  return { sessions, degraded: false };
}

/** Blocked sessions, longest wait first. Ties broken by sessionId so output is stable. */
export function blockedOf(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.status === "waiting")
    .sort((a, b) =>
      a.blockedSince !== b.blockedSince
        ? a.blockedSince - b.blockedSince
        : a.sessionId.localeCompare(b.sessionId)
    );
}
