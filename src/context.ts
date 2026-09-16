/** Recovering "which session IS this?" from the transcript.
 *
 *  A name like "Parallel agents implementation" plus "input needed" does not tell
 *  you what the session wants. The answer is already on disk — the last thing you
 *  asked, the last thing Claude said, the branch, any PR it opened — and it costs
 *  a bounded tail read, not a summarisation.
 *
 *  PRIVACY: this is the one part of agentview that reads message content. It never
 *  leaves the machine, it is never logged, and only the most recent ~256KB of a
 *  transcript is ever touched. The *.key files in the sessions directory remain
 *  entirely off limits. */

import { open, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 256 * 1024;

export interface SessionContext {
  branch?: string;
  pr?: number;
  prUrl?: string;
  /** The last thing YOU typed. Usually the single most identifying line. */
  lastPrompt?: string;
  /** The last thing Claude said in prose (tool calls skipped). */
  lastSay?: string;
  /** Which model the session is on. Not in the state file or `claude agents --json`
   *  — only on the transcript's assistant records. */
  model?: string;
}

/** "claude-opus-5" -> "opus-5", "claude-haiku-4-5-20251001" -> "haiku-4.5". */
export function shortModel(raw: string | undefined): string {
  if (!raw || raw === "<synthetic>") return "";
  return raw.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/(\d)-(\d)/, "$1.$2");
}

/** Depth 2 only: skips <project>/<sessionId>/subagents/ and memory/. */
export async function findTranscript(sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS, d, `${sessionId}.jsonl`);
    try {
      await stat(p);
      return p;
    } catch {
      /* not in this project dir */
    }
  }
  return null;
}

async function tailLines(path: string, bytes = TAIL_BYTES): Promise<string[]> {
  const st = await stat(path);
  const start = Math.max(0, st.size - bytes);
  const len = Math.min(bytes, st.size);
  if (len === 0) return [];
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString("utf8");
    // Drop the first (probably partial) line unless we read from the very start.
    const body = start === 0 ? text : text.slice(text.indexOf("\n") + 1);
    return body.split("\n").filter(Boolean);
  } finally {
    await fh.close();
  }
}

export function extract(lines: string[]): SessionContext {
  const out: SessionContext = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: any;
    try {
      o = JSON.parse(lines[i]!);
    } catch {
      continue; // a torn line in the tail is expected, not an error
    }
    if (!out.branch && typeof o.gitBranch === "string" && o.gitBranch && o.gitBranch !== "HEAD") {
      out.branch = o.gitBranch;
    }
    if (!out.pr && o.type === "pr-link" && typeof o.prNumber === "number") {
      out.pr = o.prNumber;
      if (typeof o.prUrl === "string") out.prUrl = o.prUrl;
    }
    if (!out.lastPrompt && o.type === "last-prompt" && typeof o.lastPrompt === "string") {
      out.lastPrompt = o.lastPrompt.trim();
    }
    if (!out.model && o.type === "assistant") {
      const m = o.message?.model;
      // "<synthetic>" marks a locally-generated record, not a real model response.
      if (typeof m === "string" && m && m !== "<synthetic>") out.model = m;
    }
    if (!out.lastSay && o.type === "assistant") {
      const txt = (o.message?.content ?? [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join(" ")
        .trim();
      if (txt) out.lastSay = txt;
    }
    if (out.branch && out.pr && out.lastPrompt && out.lastSay && out.model) break;
  }
  return out;
}

const cache = new Map<string, { mtimeMs: number; size: number; ctx: SessionContext }>();

/** Cached on (mtime, size) so a busy session is re-read only when it actually grows. */
export async function contextFor(sessionId: string): Promise<SessionContext> {
  const path = await findTranscript(sessionId);
  if (!path) return {};
  try {
    const st = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.ctx;
    const ctx = extract(await tailLines(path));
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, ctx });
    return ctx;
  } catch {
    return {};
  }
}

/** Collapse whitespace and clip, so a paragraph fits one terminal line. */
export function oneLine(text: string | undefined, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + "…";
}

/** Wrap to a width for the detail view, indented. */
export function wrap(text: string, width: number, indent: string): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      if (cur) lines.push(indent + cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(indent + cur);
  return lines;
}
