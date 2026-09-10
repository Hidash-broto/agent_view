# PLAN: agentview — the neglect detector

Design doc: `~/.gstack/projects/terminal-with-tab-name/hidash-unknown-design-20260910-071553.md`
Branch: main
Status: DRAFT v2 — v1 killed at the /autoplan CEO gate, see Review History
Stack: TypeScript on Bun, `bun build --compile`

## The one sentence

**Nothing tells you an agent has been blocked for 22 hours.**

Every incumbent alerts at the *moment* a session blocks. If you are asleep, in a
meeting, or looking at another window, that alert is spent and nothing ever raises
it again. agentview answers the question none of them ask: *what have I abandoned?*

Measured on this machine, 2026-09-10: `erp-00` sat in `status: "waiting"`,
`waitingFor: "input needed"` for **1367 minutes**. Re-measured 4.5 hours later during
this same planning session: **1603 minutes**, still waiting, still unmentioned by
anything. The pain compounds silently, which is exactly the shape of the gap.

## What this is NOT

Not a session manager. That lane has five active projects and we are not entering it.

| Already shipped, do not rebuild | By |
|---|---|
| Session list, states, TUI | Agent of Empires (3.2k★), agent-deck (863★) |
| Title sync from Claude's session name | agent-deck (`push_title`, `--title-lock`) |
| `~/.claude/sessions/<pid>.json` PID→session join | Recon |
| Cross-terminal window focus (iTerm2/Terminal.app/Ghostty) | claude-code-monitor |
| Alert at the moment of blocking | Claude Code Notifier |
| Backgrounded session management | `claude agents`, first-party |

**The gap: duration, and re-surfacing.** Nobody sorts by how long you have ignored
something, and nobody tells you twice.

## Core design: escalation, not notification

A notification fired once is a notification you can miss. The entire product is the
refusal to fire once.

```
  session enters `waiting`
        |
        v
  t+5m   ── quiet notice ──────────  "erp is waiting"
        |
  t+30m  ── notice again ──────────  "erp waiting 30m"
        |
  t+2h   ── escalate ──────────────  "erp waiting 2h"
        |
  t+8h   ── escalate ──────────────  "erp waiting 8h. Still there."
        |
  daily  ── keeps escalating ──────  until answered or dismissed
```

Two rules that make it work rather than become noise:

1. **Escalating intervals, never fixed.** A 5-minute repeat is spam and gets muted.
   Muting returns you to 22 hours. Intervals grow: 5m, 30m, 2h, 8h, then daily.
2. **Dismissal is per-session and expires.** `agentview mute <id>` silences one
   session for 24h, not forever. There is no global mute; a tool you can permanently
   silence is a tool that will be permanently silenced.

## Milestones

### M1 — `agentview` (one shot)

Prints blocked sessions sorted by duration, longest first. Exits.

```
$ agentview

  BLOCKED 22h  erp-00                    input needed
  BLOCKED  6h  billing-a3             input needed
  blocked  4m  billing-4e             input needed

  3 waiting. Oldest 22h.
```

Nothing else. No TUI, no focus, no attach. This is the whole M1.

### M2 — `agentview watch` (the daemon)

Escalation ladder above. macOS notification via `osascript`. Writes
`~/.agentview/agentview.log`. Survives `claude` restarts and Claude Code upgrades.

### M3 — `agentview doctor`

Self-check: does `~/.claude/sessions/` exist, does its shape still carry
`status` and `statusUpdatedAt`, does `claude agents --json` agree on the pid set.
Prints a diagnosis, exits non-zero on drift. This is the insurance policy for
building on an undocumented internal path.

### M4 — Release

`bun build --compile`, Actions on tag, Homebrew tap. **Gated on one week of daily
personal use.** Not before.

## Data layer

Smaller than v1, because duration needs less than identity does.

**Required fields, all from `~/.claude/sessions/<pid>.json`:**

| Field | Use | Verified |
|---|---|---|
| `status` | `waiting` is the only state we act on | yes, 6/6 live files |
| `statusUpdatedAt` | **the product.** now - this = duration | yes |
| `waitingFor` | shown verbatim | yes, `"input needed"` |
| `pid` | liveness check via `ps -p` | yes |
| `name` | fallback label | yes |
| `sessionId` | mute key, title lookup | yes |
| `cwd` | disambiguation | yes |

**Title is optional here, which is the point.** v1 needed the transcript join to be
useful. v2 does not: `erp-00` plus `blocked 22h` is already actionable. Title lookup
becomes a nice-to-have (M1.5), not a dependency, which deletes `titles.ts`, the slug
derivation, the head-vs-tail scan bug, and seven tests.

**Source fallback:** if `~/.claude/sessions/` is absent or its shape has drifted, fall
back to `claude agents --json`, which carries `status` but **not** `statusUpdatedAt`.
Degraded mode shows "blocked (duration unknown, since agentview started)" and says so.
Never fabricate a duration.

## File layout

```
src/
  cli.ts              arg parsing: (none) | watch | doctor | mute <id>
  sessions.ts         read Source 0, validate shape, filter dead pids, fallback
  duration.ts         humanize, escalation ladder, next-notify-at
  state.ts            ~/.agentview/state.json — last-notified, mutes
  notify.ts           osascript wrapper
  doctor.ts           shape + agreement checks
test/
  sessions.test.ts
  duration.test.ts
  state.test.ts
  fixtures/
```

Seven source files. v1 had eleven for a bigger idea.

## Function contracts

```ts
interface Blocked {
  sessionId: string;
  pid: number;
  name: string;
  cwd: string;
  waitingFor: string;
  blockedSince: number;      // ms epoch, from statusUpdatedAt
  blockedMs: number;         // now - blockedSince
  durationKnown: boolean;    // false in CLI-fallback mode
}

// Blocked sessions only, sorted by blockedMs desc. Dead pids excluded.
async function blocked(): Promise<Blocked[]>

// 1367*60000 -> "22h"; 369*60000 -> "6h"; 4*60000 -> "4m"; 30000 -> "now"
function humanize(ms: number): string

// The ladder. Returns the next notify timestamp given how long it has been
// blocked and when we last notified. null = do not notify yet.
function nextNotifyAt(blockedMs: number, lastNotifiedMs: number | null): number | null

// Per-session, 24h expiry. No global mute by design.
function isMuted(sessionId: string, now: number): boolean
```

## Test plan

**`duration.test.ts`** — the product logic, tested hardest.
1. `humanize` boundaries: 0, 59s, 60s, 59m, 60m, 1h59m, 2h, 23h59m, 24h, 1367m.
2. Ladder fires at 5m and not at 4m59s.
3. Ladder does not re-fire at 6m when last notified at 5m.
4. Ladder fires at 30m, 2h, 8h, then every 24h and not more often.
5. A session blocked 22h with no prior notification fires immediately, once, then
   follows the daily cadence. Guards the "agentview started after the block" case.
6. Ladder never returns a timestamp in the past.

**`sessions.test.ts`**
7. Only `status: "waiting"` rows are returned; `busy` and `idle` excluded.
8. Dead pid excluded even though its file exists.
9. `statusUpdatedAt` missing → `durationKnown: false`, no crash, no fabricated time.
10. `~/.claude/sessions/` absent → CLI fallback, `durationKnown: false`, logged once.
11. Malformed JSON in one file does not prevent the other files from being read.
12. Sort is strictly by `blockedMs` desc, ties broken by `sessionId` for stability.

**`state.test.ts`**
13. Mute expires after exactly 24h.
14. State file absent → treated as no mutes, no prior notifications, no crash.
15. State file corrupt → reset, log, continue. Never crash the daemon.
16. Two `agentview watch` processes do not double-notify (lockfile or single-writer).

## Failure modes

| # | Failure | Severity | Response |
|---|---|---|---|
| F1 | `~/.claude/sessions/` shape drifts after a CC upgrade | HIGH | validate on read; degrade to CLI; `doctor` names it |
| F2 | Notification storm | **CRITICAL** | escalating ladder + `lastNotifiedAt` in state. A tool that spams gets muted, and muted returns you to 22h. This is the failure that kills the product. |
| F3 | User mutes globally and forgets | HIGH | no global mute exists. Per-session, 24h expiry only. |
| F4 | Daemon dies silently | HIGH | `~/.agentview/agentview.log` + our own heartbeat in `~/.agentview/state.json`. **Not** `updatedAt`: measured `updatedAt === statusUpdatedAt` in 7/7 live files (delta 0), so it is a transition timestamp too, not a liveness signal. An idle session's `updatedAt` is hours stale by design. |
| F5 | Two daemons running | MEDIUM | lockfile at `~/.agentview/watch.lock` |
| F6 | Clock skew / sleep | MEDIUM | durations from wall clock; a laptop asleep 8h correctly shows 8h |
| F7 | `statusUpdatedAt` semantics differ from assumption | HIGH | M0 check below; if it is last-activity rather than state-entry, durations are wrong and the product is wrong |

## M0 — verification before code (BLOCKING, and it can actually fail)

| # | Check | Kills the project if |
|---|---|---|
| M0.1 | ~~Block a session, confirm `statusUpdatedAt` does not move while blocked.~~ **PASSED 2026-09-10.** `erp-00` held `statusUpdatedAt=1788941105597` unchanged across a 4.5-hour observation while `status` stayed `waiting`, as other sessions' values moved on their own transitions. It is a transition timestamp. | n/a — cleared |
| M0.2 | Confirm `status` returns to `busy`/`idle` promptly once answered, so mutes and ladders reset. | It sticks, and every answered session keeps nagging. |
| M0.3 | Confirm a laptop sleep/wake cycle does not reset `statusUpdatedAt`. | It resets, and the 22h case reports as minutes. |

M0.1 was the real gate and it **cleared** on live data before any code was written.
M0.2 and M0.3 remain open and are each ten minutes of work.

Standing evidence: `erp-00` has now been blocked **1603 minutes (26.7 hours)**. It
gained four hours during this planning session. Nothing on the machine mentions it.

## Success criteria

1. **No session stays blocked more than 1 hour without you being told at least twice.**
   Measured over one week of real use.
2. Running `agentview` cold on a machine with a 22-hour-blocked session reports 22h,
   not "just now." Guards the started-late case.
3. Zero notifications for sessions that are `busy` or `idle`. False positives are
   worse than misses here, because they cause muting.
4. Daemon survives a Claude Code upgrade, or `doctor` explains why it did not.
5. One week of daily use without the user muting anything out of annoyance.

## Open questions

1. **M0.1 outcome.** Blocking. Ten minutes to answer.
2. **Notification mechanism.** `osascript -e 'display notification'` needs no
   permission and is unstyled. Evaluate at M2; do not add a dependency for polish.
3. **Should M1.5 (title lookup) exist at all?** `erp-00` + `22h` may be sufficient.
   Decide after a week of use, not now.
4. **Escalation thresholds.** 5m/30m/2h/8h/daily is a guess. The right answer comes
   from a week of use.

## Review History

**v1 (killed at the CEO gate).** v1 was a session manager: TUI, title join, window
focus. The /autoplan CEO phase plus an independent outside voice found every wedge
occupied, verified against live sources:

- `~/.claude/sessions/<pid>.json` as the PID join — **Recon** has shipped it for a year.
  This was presented to the user as a novel discovery during /office-hours. It was not.
- "The rows have real names" — **agent-deck** (863★) ships `push_title` with
  `--title-lock`.
- Cross-terminal window focus, proposed by the outside voice as the one unclaimed
  wedge — **claude-code-monitor** ships it across iTerm2, Terminal.app, and Ghostty.
  The outside voice's positive finding did not survive verification either.
- Alert-on-block — **Claude Code Notifier** ships it.

What survived: duration and re-surfacing. Nobody sorts by neglect; nobody tells you
twice. That is v2.

**Carried forward from the v1 CEO review:**
- C1 (proxy problem): a tool you must remember to open cannot solve unattended
  blocking. v2 is built on this finding rather than contradicting it.
- E5 → M3 `doctor`. C5 → the log file. Both accepted into scope.
- F9 (notification storm) → v2 F2, promoted to CRITICAL and made the core design
  constraint rather than an edge case.
