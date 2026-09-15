#!/usr/bin/env bun
import { readSessions, blockedOf } from "./sessions.ts";
import { renderBlockedRow, renderEmpty, humanize, label, labelWidth } from "./format.ts";
import { addSnooze, removeSnooze, loadSnoozes } from "./snoozes.ts";
import { watch } from "./watch.ts";
import { doctor } from "./doctor.ts";
import { contextFor, oneLine, wrap } from "./context.ts";
import { c } from "./ui.ts";
import { HOUR, MIN } from "./ladder.ts";
import type { Session } from "./types.ts";

const USAGE = `agentview — which Claude sessions have been waiting on you, and for how long

  agentview                 list sessions waiting for input
  agentview --idle          also show sessions idle over 4h
  agentview watch           run the notifier in this terminal (Ctrl-C to stop)
  agentview snooze <name> [4h]   quiet one session for a while
  agentview ack <name>      "I handled it" — silence this block for good
  agentview unsnooze <name> undo either of the above
  agentview show <name>     what this session is about: branch, PR, last exchange
  agentview doctor          check what agentview can see, and what it touches
`;

function parseDuration(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const m = /^(\d+)([mh])$/.exec(s.trim());
  if (!m) return fallback;
  return Number(m[1]) * (m[2] === "h" ? HOUR : MIN);
}

/** Resolve a name prefix to one session. A UUID is not an affordance: at the moment
 *  of annoyance the user is looking at a notification, not a terminal. */
function resolve(sessions: Session[], query: string): Session | { error: string } {
  const q = query.toLowerCase();
  const exact = sessions.filter((s) => s.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const hits = sessions.filter(
    (s) => s.name.toLowerCase().startsWith(q) || s.sessionId.startsWith(query)
  );
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) return { error: `No session matches "${query}".` };
  const names = hits.map((h) => `  ${h.name}  ${label(h).split("  ")[0]}`).join("\n");
  return { error: `"${query}" matches ${hits.length} sessions:\n${names}\nBe more specific.` };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const now = Date.now();

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }

  if (cmd === "doctor") {
    const r = await doctor(now);
    console.log(r.lines.join("\n"));
    return r.ok ? 0 : 1;
  }

  if (cmd === "watch") {
    await watch();
    return 0;
  }

  if (cmd === "show") {
    const query = rest[0];
    const { sessions } = await readSessions();
    if (!query) {
      console.error("agentview show: which session? Run 'agentview' to see the names.");
      return 1;
    }
    const target = resolve(sessions, query);
    if ("error" in target) { console.error(target.error); return 1; }
    const k = await contextFor(target.sessionId);
    const where = target.cwd.split("/").filter(Boolean).slice(-2).join("/");
    const dur = target.durationKnown ? humanize(now - target.blockedSince) : "??";
    const tags = [where, k.branch ? `branch ${k.branch}` : "", k.pr ? `PR #${k.pr}` : ""]
      .filter(Boolean).join(" · ");

    console.log("");
    console.log(`  ${c.bold(target.name)}`);
    console.log(`  ${c.dim(tags)}`);
    console.log(
      `  ${target.status === "waiting" ? c.yellow(`waiting ${dur} · ${target.waitingFor ?? "input needed"}`) : c.dim(`${target.status} ${dur}`)}`
    );
    if (k.lastPrompt) {
      console.log("");
      console.log(`  ${c.dim("You last said:")}`);
      for (const l of wrap(k.lastPrompt, 72, "    ")) console.log(l);
    }
    if (k.lastSay) {
      console.log("");
      console.log(`  ${c.dim("It last said:")}`);
      for (const l of wrap(k.lastSay, 72, "    ")) console.log(c.dim(l));
    }
    if (k.prUrl) { console.log(""); console.log(`  ${c.dim(k.prUrl)}`); }
    if (!k.lastPrompt && !k.lastSay) {
      console.log("");
      console.log(`  ${c.dim("No transcript found for this session.")}`);
    }
    console.log("");
    return 0;
  }

  if (cmd === "snooze" || cmd === "ack" || cmd === "unsnooze") {
    const query = rest[0];
    if (!query) {
      console.error(`agentview ${cmd}: which session? Run 'agentview' to see the names.`);
      return 1;
    }
    const { sessions } = await readSessions();
    if (cmd === "unsnooze") {
      const target = resolve(sessions, query);
      const id = "error" in target ? query : target.sessionId;
      const n = await removeSnooze(id);
      console.log(n ? `Cleared ${n} entr${n === 1 ? "y" : "ies"}.` : "Nothing was snoozed.");
      return 0;
    }
    const target = resolve(sessions, query);
    if ("error" in target) {
      console.error(target.error);
      return 1;
    }
    if (cmd === "ack") {
      await addSnooze(
        { sessionId: target.sessionId, blockedSince: target.blockedSince, until: null },
        now
      );
      console.log(
        `Acked ${target.name} (${target.sessionId.slice(0, 8)}). ` +
          `Silent until it asks something new.`
      );
    } else {
      const ms = parseDuration(rest[1], 4 * HOUR);
      await addSnooze(
        { sessionId: target.sessionId, blockedSince: target.blockedSince, until: now + ms },
        now
      );
      console.log(
        `Snoozed ${target.name} (${target.sessionId.slice(0, 8)}) for ${humanize(ms)}.`
      );
    }
    return 0;
  }

  // Default: the one-shot list.
  const showIdle = cmd === "--idle" || rest.includes("--idle");
  const { sessions, degraded } = await readSessions();
  const blocked = blockedOf(sessions);
  const snoozed = new Set((await loadSnoozes()).map((s) => s.sessionId));

  const idle = sessions.filter(
    (s) => s.status === "idle" && s.durationKnown && now - s.blockedSince > 4 * HOUR
  );

  if (blocked.length === 0) {
    console.log(renderEmpty(sessions, now));
    // --idle is most useful precisely when nothing is blocked, so honour it here too.
    if (showIdle && idle.length) {
      console.log("");
      for (const s of idle.sort((a, b) => a.blockedSince - b.blockedSince)) {
        console.log(`  idle    ${humanize(now - s.blockedSince).padStart(4)}  ${label(s)}`);
      }
    }
    return 0;
  }

  console.log("");
  const w = labelWidth(blocked);
  for (const s of blocked) {
    const mark = snoozed.has(s.sessionId) ? "  (snoozed)" : "";
    console.log(renderBlockedRow(s, now, w) + mark);
  }

  console.log("");
  const oldest = blocked[0];
  const summary =
    `  ${blocked.length} waiting` +
    (oldest?.durationKnown ? `. Oldest ${humanize(now - oldest.blockedSince)}.` : ".");
  console.log(
    idle.length && !showIdle
      ? `${summary} Also ${idle.length} idle over 4h (--idle to show).`
      : summary
  );

  if (showIdle && idle.length) {
    console.log("");
    for (const s of idle) {
      console.log(`  idle    ${humanize(now - s.blockedSince).padStart(4)}  ${label(s)}`);
    }
  }
  if (degraded) console.log("\n  (degraded: durations unavailable — run 'agentview doctor')");
  return 0;
}

main().then((code) => process.exit(code));
