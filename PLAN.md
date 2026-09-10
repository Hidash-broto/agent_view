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

---

# DX REVIEW (Phase 2.5 — /autoplan, DX POLISH)

Product type: **CLI Tool**. Persona: solo developer running 5-10 concurrent Claude
Code sessions across projects, macOS, already comfortable in a terminal.
Phase 2 (Design) skipped: 1 UI-scope match ("File layout"), below threshold.

## Developer Journey Map

| # | Stage | Current plan | Friction |
|---|-------|--------------|----------|
| 1 | Discover | GitHub README | Crowded lane. Must lead with "22 hours", not "session manager". |
| 2 | Evaluate | README screenshot | **The screenshot needs a blocked session to exist.** Hard to demo. |
| 3 | Install | `brew install` | Fine, once the tap exists (M4). |
| 4 | Hello world | `agentview` | **BROKEN — see D1.** Most likely output is nothing. |
| 5 | Integrate | `agentview watch` | **UNSPECIFIED — see D2.** No launchd, no start-at-login. |
| 6 | Debug | `agentview doctor` | Good. Best part of the plan. |
| 7 | Upgrade | brew upgrade | Daemon restart unhandled. Stale daemon keeps running old code. |
| 8 | Scale | n/a | Single user, single machine. Correctly out of scope. |
| 9 | Uninstall | **absent** | Daemon + `~/.agentview/` + launchd entry, no removal path. |

## Developer Empathy Narrative

> I read "nothing tells you an agent has been blocked for 22 hours" and I recognize
> it instantly, because that happened to me last Tuesday. I install it. I run
> `agentview`.
>
> Nothing happens.
>
> Well — it prints nothing, or maybe "0 waiting." I don't know if it's working or if
> it's broken. I don't have a blocked session right now, because I'm sitting here
> paying attention. The only way to see this tool do its thing is to go create the
> exact problem I installed it to avoid, then wait five minutes.
>
> So I run it again. Still nothing. I check the README. It says run `agentview watch`.
> I do. It prints nothing and... does it stay running? Did it fork? If I close this
> terminal does it die? Is it going to start when I reboot? I don't know.
>
> I close the terminal. The daemon dies. Three days later an agent sits blocked for
> nine hours and nothing tells me, because the tool I installed to fix that has not
> been running since Tuesday.

That narrative is the whole DX review. Two findings follow from it.

## D1 — CRITICAL: the empty state IS the default state

A monitoring tool whose value moment requires a failure to already be happening has
no hello world. On a healthy machine `agentview` prints nothing useful, which is
indistinguishable from broken.

**Fix (accepted into scope, P1 + P5):** `agentview` with zero blocked sessions must
still prove it works, by showing what it is watching.

```
$ agentview

  ✓ Nothing blocked.

  Watching 7 sessions:
    busy  2   terminal-with-tab-name, billing
    idle  5   erp, billing, back-end-server, ...

  Longest wait today: erp-00, 26h (answered 12m ago)
```

Three jobs in one screen: confirms it works, shows the data pipeline is live, and
the "longest wait today" line makes the value legible on a good day. That last line
is the magical moment for this product, and it costs one persisted counter.

## D2 — CRITICAL: daemon lifecycle is entirely unspecified

The plan says "M2 — `agentview watch` (the daemon)" and stops. A daemon a user must
remember to start is the same failure class as a dashboard a user must remember to
open, which is the exact thing C1 killed v1 for. **v2 reintroduces its own bug.**

**Fix (accepted into scope):** the daemon must install itself.

| Command | Does |
|---|---|
| `agentview watch` | run in foreground, Ctrl-C to stop. For trying it. |
| `agentview start` | write `~/Library/LaunchAgents/dev.agentview.plist`, `launchctl load`. Survives reboot. |
| `agentview status` | is it running, since when, pid, last poll, sessions seen |
| `agentview stop` | unload, keep the plist |
| `agentview uninstall` | unload, remove plist, remove `~/.agentview/`, print what it removed |

`agentview status` also answers "is it alive" from D-narrative paragraph 3, and
covers the brew-upgrade staleness gap in journey stage 7.

## D3 — HIGH: `mute <id>` demands an id the user does not have

At the moment of annoyance the user is looking at a notification, not a terminal, and
does not know any session id. A UUID is the wrong affordance.

**Fix:** mute by human name, which is already in the data (`name`, e.g. `erp-00`),
with prefix matching: `agentview mute erp`. Bare `agentview mute` with no argument
mutes the session that most recently notified, which is the one that just annoyed you.

## D4 — HIGH: no error strings are specified anywhere

Every failure mode in the plan names a condition and a response, and none of them say
what the user reads. Per DX principle 5, every error needs problem + cause + fix.

| Condition | String |
|---|---|
| `~/.claude/sessions/` absent | `agentview: can't find ~/.claude/sessions/`<br>`Claude Code writes this directory from v2.1.x. Yours may be older, or set CLAUDE_CONFIG_DIR.`<br>`Falling back to 'claude agents --json' — durations will be unavailable.`<br>`Run 'agentview doctor' for details.` |
| Shape drift after upgrade | `agentview: ~/.claude/sessions/ no longer has 'statusUpdatedAt'.`<br>`A Claude Code update probably changed the format. Durations are off until this is fixed.`<br>`Please report at <repo>/issues with the output of 'agentview doctor'.` |
| Daemon already running | `agentview: already running (pid 4821, started 3h ago).`<br>`Use 'agentview status' to check it, or 'agentview stop' first.` |

## D5 — MEDIUM: thresholds are hardcoded guesses with no escape hatch

5m/30m/2h/8h/daily is admitted in the plan as a guess. DX principle 4 says decide for
me, let me override. **Fix:** read `~/.agentview/config.json` if it exists, ignore it
if it does not. Five lines, no config command, no docs burden at v0.1.0.

**TASTE DECISION** — surfaced at the gate. P5 (simpler) argues for shipping the
guess alone and letting a week of real use pick the numbers.

## D6 — MEDIUM: trust surface is undocumented

It reads another tool's internal files, runs a background daemon, and writes to the
home directory. A cautious developer needs that stated before installing.

**Fix:** README section, exact wording:
- **Reads:** `~/.claude/sessions/*.json` (state only), `ps` (liveness). Never your transcripts, prompts, or code.
- **Writes:** `~/.agentview/` (state, log), one launchd plist.
- **Sends:** nothing. No network calls. Verify with `grep -r fetch src/`.

That last clause is the trust move: an invitation to check rather than a promise.

## Notification copy

The plan never writes the notification. It is the entire user-facing surface of M2.

| When | Title | Body |
|---|---|---|
| t+5m | `erp is waiting` | `input needed · 5m` |
| t+30m | `erp still waiting` | `input needed · 30m` |
| t+2h | `erp waiting 2h` | `input needed since 09:14` |
| t+8h+ | `erp waiting 8h` | `input needed since 09:14. Still there.` |

Switch from relative to absolute time at the 2h step. "Waiting 8h" is abstract;
"since 09:14" tells you it has been there since before lunch and lands harder.

## TTHW Assessment

| | Time | Tier |
|---|---|---|
| Current plan | **unbounded** — requires a blocked session to exist | Red Flag |
| With D1 | ~30 seconds to proof-of-life | Champion |
| To first real value | 5m-8h (first genuine block) | inherent to the product |

The product cannot shorten time-to-first-real-value; that is set by when you next get
blocked. It absolutely can shorten time-to-confidence, and D1 is how.

## DX Scorecard

| # | Dimension | Score | Note |
|---|-----------|-------|------|
| 1 | Getting started / TTHW | **2/10** | empty state reads as broken (D1) |
| 2 | CLI naming & ergonomics | 6/10 | verbs fine; `mute <id>` wrong (D3); lifecycle verbs missing (D2) |
| 3 | Error messages | **1/10** | zero strings specified (D4) |
| 4 | Docs | 3/10 | no README plan; trust section absent (D6) |
| 5 | Upgrade path | 3/10 | stale daemon after brew upgrade unhandled |
| 6 | Escape hatches | 4/10 | thresholds hardcoded (D5) |
| 7 | Debuggability | **8/10** | `doctor` is the strongest part of the plan |
| 8 | Trust & uninstall | 2/10 | no uninstall path at all (D2, D6) |

**Overall DX: 3.6/10** before fixes. With D1-D4 accepted: **7.5/10**.

**Highest-leverage single change: D1.** Everything else is polish on a tool the
developer has already decided is broken thirty seconds after installing it.

## DX Implementation Checklist

- [ ] D1 empty state with watch-list and "longest wait today" (M1)
- [ ] D2 `start` / `status` / `stop` / `uninstall` + launchd plist (M2)
- [ ] D3 mute by name prefix; bare `mute` targets last notifier (M2)
- [ ] D4 the three error strings above, verbatim (M1-M2)
- [ ] D5 optional `~/.agentview/config.json`, read-if-exists (M2) — TASTE
- [ ] D6 README trust section (M4)
- [ ] Notification copy table, including the 2h switch to absolute time (M2)
