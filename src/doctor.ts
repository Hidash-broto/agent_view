/** Shape check only. The notification-delivery round-trip is deferred (see TODOS):
 *  the obvious implementation checks the `presented` column, which is NOT a
 *  delivery flag — it tracks whether a banner is currently on screen, so an
 *  auto-dismissed notification reads 0. Measured on a healthy machine: 64 rows at
 *  0, 8 at 1. Shipping that check would fail on a working machine and teach the
 *  user to ignore doctor. */

import { DEFAULT_DIR, listStateFiles, readSessions, claudeAgentsJson } from "./sessions.ts";
import { DIR, STATE_PATH } from "./state.ts";
import { SNOOZE_PATH } from "./snoozes.ts";
import { loadConfig, describe as describeConfig, CONFIG_PATH } from "./config.ts";
import { DEFAULT_CONFIG } from "./tick.ts";

export interface DoctorReport {
  lines: string[];
  ok: boolean;
}

export async function doctor(now = Date.now()): Promise<DoctorReport> {
  const lines: string[] = [];
  let ok = true;

  lines.push("agentview doctor");
  lines.push("");
  lines.push("Reads:");
  lines.push(`  ${DEFAULT_DIR}/*.json   (state only — never *.key, never transcripts)`);
  lines.push("Writes:");
  lines.push(`  ${STATE_PATH}`);
  lines.push(`  ${SNOOZE_PATH}`);
  lines.push(`  ${DIR}/agentview.log`);
  lines.push("Sends: nothing. No network calls. Verify with: grep -rn 'fetch\\|http' src/");
  lines.push("");

  const { config, source, warnings } = await loadConfig(DEFAULT_CONFIG);
  lines.push(`Ladder: ${describeConfig(config)}`);
  lines.push(`        from ${source === "file" ? CONFIG_PATH : "built-in defaults"}`);
  for (const w of warnings) lines.push(`        ${w}`);
  lines.push("");

  const files = await listStateFiles();
  if (files.length === 0) {
    ok = false;
    lines.push(`FAIL  ${DEFAULT_DIR} has no *.json files.`);
    lines.push("      Claude Code writes this directory from v2.1.x. Yours may be older.");
    const cli = await claudeAgentsJson();
    lines.push(
      cli
        ? `      Falling back to 'claude agents --json' (${cli.length} sessions) — durations unavailable.`
        : "      'claude agents --json' also unavailable. Is claude on PATH?"
    );
  } else {
    lines.push(`OK    ${files.length} session file(s) in ${DEFAULT_DIR}`);
  }

  const { sessions, degraded } = await readSessions();
  const withTs = sessions.filter((s) => s.durationKnown).length;
  if (sessions.length > 0 && withTs === 0) {
    ok = false;
    lines.push("FAIL  No session carries statusUpdatedAt.");
    lines.push("      A Claude Code update probably changed the format. Durations are");
    lines.push("      unavailable until this is fixed. Please report with this output.");
  } else if (sessions.length > 0) {
    lines.push(`OK    ${withTs}/${sessions.length} sessions carry statusUpdatedAt (durations work)`);
  }

  const blocked = sessions.filter((s) => s.status === "waiting");
  lines.push(`      ${blocked.length} waiting, ${sessions.length} live${degraded ? " (degraded)" : ""}`);

  // Record the waitingFor value space. If Claude Code ever emits a short-lived
  // waiting state under a different reason, we want to see it before we start
  // escalating on prompts that resolve in eight seconds.
  const reasons = [...new Set(sessions.filter((s) => s.waitingFor).map((s) => s.waitingFor!))];
  if (reasons.length) lines.push(`      waitingFor values seen: ${reasons.join(", ")}`);

  lines.push("");
  lines.push("Notifications arrive attributed to \"Script Editor\" — known, v0.1.0 limitation.");
  lines.push("Delivery is NOT verified: osascript exits 0 whether or not it displayed.");

  return { lines, ok };
}
