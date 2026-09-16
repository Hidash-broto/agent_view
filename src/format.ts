/** Presentation only. Pure. Separate from ladder.ts because policy and display
 *  change for different reasons and are consumed by different layers. */

import { MIN, HOUR } from "./ladder.ts";
import type { Session } from "./types.ts";

/**
 * Compact duration. Hours all the way up rather than switching to days: for a
 * neglect detector "72h" lands harder than "3d", which is the entire point.
 * Negative input clamps to "now" — NTP can step the clock backwards.
 */
export function humanize(ms: number): string {
  const clamped = Math.max(0, ms);
  const mins = Math.floor(clamped / MIN);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(clamped / HOUR)}h`;
}

/** "Mon 09:45" — absolute beats relative once you are past a couple of hours.
 *  "waiting 8h" is abstract; "since Mon 09:45" tells you it predates lunch. */
export function absoluteTime(epochMs: number, now: number = Date.now()): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `${hh}:${mm}`;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${hh}:${mm}`;
}

/** `acme/erp` — the cwd basename is MANDATORY, not decorative.
 *  Measured on a real machine: erp-00 and erp-0e differ by one character and one of
 *  them was the blocked one. Three sessions shared the billing directory. */
export function label(s: Session): string {
  const base = s.cwd.split("/").filter(Boolean).slice(-1)[0] ?? "?";
  const parent = s.cwd.split("/").filter(Boolean).slice(-2, -1)[0];
  const where = parent ? `${parent}/${base}` : base;
  return `${where}  ${s.name}`;
}

export function renderBlockedRow(s: Session, now: number, labelWidth = 0, model = ""): string {
  const ms = Math.max(0, now - s.blockedSince);
  const dur = s.durationKnown ? humanize(ms).padStart(4) : "  ??";
  const tag = ms >= 2 * HOUR ? "BLOCKED" : "blocked";
  const since = s.durationKnown ? ` since ${absoluteTime(s.blockedSince, now)}` : "";
  const m = model ? `${model.padEnd(9)}  ` : "";
  return `  ${tag} ${dur}  ${label(s).padEnd(labelWidth)}  ${m}${s.waitingFor ?? "input needed"}${since}`;
}

/** Column width is a property of the whole visible set, not of one row. */
export function labelWidth(rows: Session[]): number {
  return rows.reduce((w, s) => Math.max(w, label(s).length), 0);
}

/**
 * The empty state is the DEFAULT state — a healthy machine has nothing blocked.
 * Printing nothing here is indistinguishable from being broken, so it has to show
 * its work: what it can see, and what the worst wait currently is.
 */
export function renderEmpty(all: Session[], now: number, models: Map<string, string> = new Map()): string {
  const busy = all.filter((s) => s.status === "busy").length;
  const idle = all.filter((s) => s.status === "idle").length;
  const lines = ["  Nothing waiting for input.", ""];
  lines.push(`  ${all.length} Claude sessions running - ${busy} busy, ${idle} idle`);
  const stalest = all
    .filter((s) => s.status === "idle" && s.durationKnown)
    .sort((a, b) => a.blockedSince - b.blockedSince)[0];
  if (stalest) {
    const d = humanize(now - stalest.blockedSince);
    const m = models.get(stalest.sessionId);
    lines.push(`  Longest idle: ${label(stalest)}${m ? ` (${m})` : ""}, ${d} (finished, no prompt since)`);
  }
  const distinct = [...new Set([...models.values()].filter(Boolean))].sort();
  if (distinct.length > 1) lines.push(`  Models in use: ${distinct.join(", ")}`);
  lines.push("", "  agentview watch    notify me when one blocks");
  return lines.join("\n");
}
