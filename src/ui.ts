/** Terminal presentation for `agentview watch`.
 *
 *  The daemon runs for hours in a tab you are not looking at. When you do look,
 *  it has to answer three questions in one glance: is it alive, what can it see,
 *  and does anything need me. Everything here serves those three. */

import { humanize, absoluteTime } from "./format.ts";
import { LADDER } from "./ladder.ts";
import type { Session } from "./types.ts";

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  Boolean(process.stdout.isTTY);

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
  cyan: wrap("36"),
  bgAlert: wrap("1;33"),
};

const RULE = "─".repeat(58);

export function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function ladderSummary(): string {
  return LADDER.map((ms) => humanize(ms)).join(" · ");
}

/** Printed once, at startup. Tells a first-time user what is about to happen. */
export function header(sessions: Session[]): string[] {
  const projects = new Set(sessions.map((s) => s.cwd)).size;
  return [
    "",
    `  ${c.cyan(c.bold("agentview"))} ${c.dim("· watching for sessions you have forgotten")}`,
    `  ${c.dim(RULE)}`,
    "",
    `  Watching ${c.bold(String(sessions.length))} Claude session${sessions.length === 1 ? "" : "s"}` +
      ` across ${c.bold(String(projects))} project${projects === 1 ? "" : "s"}.`,
    `  ${c.dim(`If one waits on you, I ping at ${ladderSummary()} — then stop.`)}`,
    `  ${c.dim("Nothing to configure. Leave this tab open.")}`,
    "",
  ];
}

function row(s: Session, now: number, longest: boolean): string {
  const where = s.cwd.split("/").filter(Boolean).slice(-2).join("/");
  const name = s.name.length > 26 ? s.name.slice(0, 25) + "…" : s.name;
  const age = s.durationKnown ? humanize(now - s.blockedSince) : "";
  if (s.status === "busy") {
    return `    ${c.green("●")} ${where.padEnd(24)} ${name.padEnd(26)} ${c.green("working")}`;
  }
  const tail = longest ? c.dim(`idle ${age}  ← longest`) : c.dim(`idle ${age}`);
  return `    ${c.dim("○")} ${c.dim(where.padEnd(24))} ${c.dim(name.padEnd(26))} ${tail}`;
}

/** The calm frame: nothing needs you, and here is the proof it is watching. */
export function calmFrame(sessions: Session[], now: number): string[] {
  const busy = sessions.filter((s) => s.status === "busy");
  const idle = sessions.filter((s) => s.status === "idle");
  const sortedIdle = [...idle].sort((a, b) => a.blockedSince - b.blockedSince);
  const longest = sortedIdle[0];

  const out = [`  ${c.green("✓")} ${c.bold("Nothing is waiting on you.")}`, ""];
  for (const s of busy) out.push(row(s, now, false));
  for (const s of sortedIdle) out.push(row(s, now, s === longest && idle.length > 1));
  out.push("");
  return out;
}

/** The alert frame. This one has to be impossible to miss in a scrollback. */
export function alertFrame(blocked: Session[], now: number, all: Session[] = blocked): string[] {
  const n = blocked.length;
  const out = [
    `  ${c.bgAlert(` ${n} SESSION${n === 1 ? "" : "S"} WAITING FOR YOU `)}`,
    "",
  ];
  for (const s of [...blocked].sort((a, b) => a.blockedSince - b.blockedSince)) {
    const where = s.cwd.split("/").filter(Boolean).slice(-2).join("/");
    const dur = s.durationKnown ? humanize(now - s.blockedSince) : "??";
    const since = s.durationKnown ? ` · since ${absoluteTime(s.blockedSince, now)}` : "";
    out.push(`    ${c.yellow("▸")} ${c.bold(where)}  ${c.bold(s.name)}`);
    out.push(
      `      ${c.yellow(`waiting ${dur}`)} · ${s.waitingFor ?? "input needed"}${c.dim(since)}`
    );
    out.push(`      ${c.dim(`answer it, or:  agentview ack ${ackHint(s, all)}`)}`);
    out.push("");
  }
  return out;
}

/** Shortest prefix that identifies this session uniquely, quoted if it needs to be.
 *  Pasting the hint has to actually work — session names can contain spaces. */
export function ackHint(s: Session, all: Session[]): string {
  const others = all.filter((o) => o.sessionId !== s.sessionId).map((o) => o.name.toLowerCase());
  const name = s.name;
  for (let i = 3; i <= name.length; i++) {
    const p = name.slice(0, i);
    if (!others.some((o) => o.startsWith(p.toLowerCase()))) {
      return /[\s"']/.test(p) ? `"${p}"` : p;
    }
  }
  return /[\s"']/.test(name) ? `"${name}"` : name;
}

export function notifiedLine(now: number, title: string): string {
  return `  ${c.dim(clock(now))}  ${c.yellow("sent")}  ${title}`;
}

/** Bottom line, rewritten in place so it never fills the scrollback. */
export function statusText(now: number, sessions: number, blocked: number, pollMs: number): string {
  const state =
    blocked > 0 ? c.yellow(`${blocked} waiting`) : c.green("all clear");
  return (
    `  ${c.dim(clock(now))}  ${state}${c.dim(
      ` · ${sessions} session${sessions === 1 ? "" : "s"} · checking every ${Math.round(pollMs / 1000)}s · Ctrl-C to stop`
    )}`
  );
}

export function writeStatus(line: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
}
export function clearStatus(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
}
