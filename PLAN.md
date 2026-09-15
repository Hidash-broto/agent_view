# PLAN: agentview — the neglect detector

Design doc: `~/.gstack/projects/terminal-with-tab-name/hidash-unknown-design-20260910-071553.md`
Branch: main
Status: **APPROVED 2026-09-14** — v0.1.0 scope cut at the /autoplan final gate.
v1 killed at the CEO gate (see Review History). Sections below the Failure Modes
table are review artifacts and are historical; File layout / Function contracts /
Test plan above are the authoritative v0.1.0 spec.
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

### M1 — the correctness core (one night)

`tick.ts`, `ladder.ts`, `state.ts`, `snoozes.ts`, `sessions.ts` plus the 14
silent-failure tests. No output yet. This is the product; everything else is a view.

### M2 — `agentview` (one shot)

Honest output on this machine is ONE row, not three. The v2 mock showed a state the
machine has never been in:

```
$ agentview

  BLOCKED 26h  acme/erp  erp-00        input needed since Mon 09:45

  1 waiting. Also 3 idle over 3h (--idle to show).
```

Empty state must prove it works, because zero-blocked is the normal case:

```
$ agentview
  Nothing waiting for input.

  7 Claude sessions running - 2 busy, 5 idle
  Longest idle: acme-api, 3h (finished, no prompt since)

  agentview watch    notify me when one blocks
```

### M3 — `agentview watch` + `snooze` + `doctor`

Foreground daemon, fixed-interval poll, `osascript` notification. **The notification
will say "Script Editor"** — misattributed, ugly, and accepted for v0.1.0 because
owning the bundle id costs Swift plus codesign plus notarization (see TODOS).
`agentview snooze erp 4h` by name prefix. `doctor` checks shape only, no delivery
round-trip.

### M4 — one week of daily use

Not a build step. The thresholds, whether idle belongs in the ladder, and whether the
misattributed notification is actually intolerable are all answered here and nowhere
else.

## Data layer

Smaller than v1, because duration needs less than identity does.

**SAFETY: `~/.claude/sessions/` is `drwx------` and contains 10 `*.key` files at
`0600`, interleaved with the JSON.** Glob `*.json` only, never `*`. Add a test that
asserts no path ending `.key` is ever opened. The README must state this before
anything else, because "reads your Claude credentials directory" is what a cautious
reader will assume otherwise.

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

**Title: REVERSED after DX review.** This plan claimed `erp-00` plus `blocked 22h`
was actionable on its own. Measured on this machine, it is not:

```
erp-00   waiting  1610m   <- the blocked one
erp-0e   idle      187m   <- differs by ONE character
billing-a3 / -bd / -d6 <- three collisions in one repo
```

At 3am, `erp-00` and `erp-0e` are a coin flip. **`cwd` basename is mandatory in every
row and every notification** (`acme/erp`, not `erp-00`). The transcript title join
returns as M1.5, optional but valuable; the cwd is not optional.

**Source fallback:** if `~/.claude/sessions/` is absent or its shape has drifted, fall
back to `claude agents --json`, which carries `status` but **not** `statusUpdatedAt`.
Degraded mode shows "blocked (duration unknown, since agentview started)" and says so.
Never fabricate a duration.

## File layout (v0.1.0 core — regenerated at the final gate)

```
src/
  cli.ts         arg parse: (none) | watch | snooze <name> [dur] | ack <name> | doctor
  sessions.ts    read *.json, validate, liveness, pid-reuse guard, CLI fallback
  ladder.ts      PURE. dueAt, highestDueRung. No I/O, no Date.now().
  format.ts      PURE. humanize, absoluteTime, renderRow, renderEmpty
  tick.ts        PURE. the decision seam. Test this hardest.
  state.ts       state.json — daemon writes only. tmp+fsync+rename, .bak, seed-not-blank
  snoozes.ts     snoozes.json — CLI writes only, daemon reads. No shared writer, no lock.
  notify.ts      osascript wrapper
  watch.ts       the loop. ~8 lines.
  doctor.ts      shape check only (no delivery round-trip — deferred, see TODOS)
test/
  tick.test.ts       ladder.test.ts     sessions.test.ts
  state.test.ts      format.test.ts     fixtures/
```

Ten source files. The v2 plan claimed seven while carrying more scope than v1; this is
the honest count for what actually ships.

## Function contracts (v0.1.0 core)

```ts
type Status = 'waiting' | 'busy' | 'idle';

interface Session {
  sessionId: string; pid: number; name: string; cwd: string;
  status: Status; waitingFor?: string;
  blockedSince: number;        // statusUpdatedAt, meaningful when status==='waiting'
  startedAt: number;           // epoch ms — the pid-reuse guard. NOT procStart.
  durationKnown: boolean;      // false in CLI-fallback mode
}

interface SessionState {
  sessionId: string;
  blockedSince: number;        // the ladder key. A change here IS a new block.
  lastRung: number;            // -1 = none delivered
  lastNotifiedAt: number | null;
  lastSeenAt: number;          // for GC
}
type State = Record<string, SessionState>;   // key: `${sessionId}:${blockedSince}`
```

**`ladder.ts` — pure, absolute, restart-invariant.** Anchored to `blockedSince`, so a
daemon restart cannot shift or reset the schedule.

```ts
const LADDER = [30*MIN, 2*HOUR, 8*HOUR, 24*HOUR, 48*HOUR];   // FINITE. See below.
const MAX_RUNG = LADDER.length - 1;        // after this: silent, list-only

function dueAt(blockedSince: number, rung: number): number;
function highestDueRung(blockedSince: number, now: number): number;  // -1 if none due
function isExhausted(rung: number): boolean { return rung >= MAX_RUNG; }
```

### The ladder is FINITE, and that is a correctness decision, not a UX one

The v2 design said "then daily, forever." That made the product's correctness depend
on a field we do not own: if `status` ever fails to leave `waiting` after the user
answers, agentview nags forever about something already handled, and the user's only
recourse is the macOS global mute — which is invisible to us and permanent (N3).

**We could not verify that `status` always clears.** A 15-minute live monitor captured
zero transitions (nothing blocked during the window). The one historical data point we
have is good — `billing-a3` went `waiting 369m` to `idle` on its own — but one
observation is not a guarantee, and the backup signal we hoped to use is unusable:
transcript mtime advances for reasons unrelated to user activity (three transcripts
touched 48m ago whose newest records were from the previous day).

So we stop depending on it:

1. **Bounded escalation.** Five notifications, ever, per block: 30m, 2h, 8h, 24h, 48h.
   Then silent. The session still appears in `agentview` output with its true duration.
   Worst case if `status` is sticky is **five wrong notifications spread over two
   days**, not an unbounded stream. Bounded blast radius by construction.
2. **`agentview ack <name>` — a manual kill switch that cannot fail.** Writes to
   `snoozes.json` keyed on `(sessionId, blockedSince)`. Silences *this block*
   permanently, with no expiry. A genuinely new block gets a new `blockedSince`, so it
   notifies normally. This is the user's guaranteed override and it depends on nothing
   Claude Code does.
   `snooze` remains the temporary form; `ack` is "I handled it, never mention it again."
3. **Fresh-activity reset.** If `statusUpdatedAt` changes while `status` is still
   `waiting`, something transitioned. Reset the ladder to rung 0 rather than continuing
   to climb — a new question in the same session deserves a fresh 30m, not the 48h rung.

**Principle: never let correctness depend on a field you do not own. Bound the damage
and give the user an override that routes around it entirely.**

**`tick.ts` — the seam the review found missing.** Everything hard happens here, and
it is pure, so everything hard is table-testable with no clock and no filesystem.

```ts
function tick(i: {
  now: number; sessions: Session[]; state: State; snoozes: Snooze[];
}): { notifications: Notification[]; nextState: State; logLines: string[] };
```

Fire iff `highestDueRung(blockedSince, now) > state.lastRung`, and fire **only that
rung**. `lastRung` advances only on delivery.

**`sessions.ts`** — glob `*.json` only, never `*`. Liveness via
`process.kill(pid, 0)` (no subprocess). Pid-reuse guard compares `startedAt` (epoch)
against parsed `ps lstart` with a 5s tolerance — never `procStart`, which is UTC
formatted as local. One `ps` call per tick, not per session.

**`watch.ts`** — poll on a fixed interval, recompute from wall clock every tick.
**Never `setTimeout` beyond one tick**: a monotonic timer sleeps through system sleep
and delivers hours late.

## Test plan (v0.1.0 core — 22 tests)

Ordered by how quietly they fail. Everything above the line fails silently and looks
like correct behaviour; write those first.

**`tick.test.ts` — silent-failure territory**
| # | Test | Guards |
|---|------|--------|
| 1 | flap: answered then re-blocked 2m ago emits NOTHING | L1, the top production-bug risk |
| 2 | 9h sleep crossing 30m+2h+8h emits ONE notification at rung 2 | L3 |
| 3 | cold start on a 26h block fires the daily rung, not 30m | L4, the headline demo |
| 4 | clock steps backwards: no notification, no negative, logs "clock" | L6 |
| 5 | snoozed session emits nothing; expired snooze emits | C1 |
| 6 | `status !== waiting` never emits | criterion 3 |
| 6a | **ladder exhausts at rung 4; a 30-day block emits exactly 5 notifications total** | sticky-status blast radius |
| 6b | **`ack` silences this block forever; a new `blockedSince` notifies again** | manual override |
| 6c | **`statusUpdatedAt` moving while still `waiting` resets the ladder to rung 0** | fresh question |

**`state.test.ts` — silent-failure territory**
| # | Test | Guards |
|---|------|--------|
| 7 | corrupt state SEEDS lastRung from current blocks, does not blank | C2, the storm |
| 8 | `.bak` is tried before any reset | C2 |
| 9 | CLI snooze written during a daemon tick survives | C1 |
| 10 | write is tmp+fsync+rename; a reader never sees a torn file | C2 |
| 11 | GC drops keys absent from the live set and older than 7d | F11 |

**`sessions.test.ts` — silent-failure territory**
| # | Test | Guards |
|---|------|--------|
| 12 | **never opens a path ending `.key`** (assert on the fs call) | trust; mandated in prose by v2 and omitted from its list |
| 13 | reused pid excluded via `startedAt` mismatch, TZ-independent | F8 |
| 14 | torn read is retried once, NOT reported as schema drift | C6 |

_Above this line: 14 tests for failures that look like success._

**Loud failures**
| # | Test | Guards |
|---|------|--------|
| 15 | dead pid excluded | liveness |
| 16 | missing `statusUpdatedAt` → durationKnown false, no fabricated time | F1 |
| 17 | dir absent → CLI fallback, logged ONCE not per tick | F1 |
| 18 | one malformed file does not block the others | resilience |
| 19 | sort by blockedMs desc, ties by sessionId | stability |

**`ladder.test.ts`**
| # | Test | Guards |
|---|------|--------|
| 20 | `dueAt` is independent of `now` — same input, same output | restart-invariance |
| 21 | rung boundaries: 29m59s→-1, 30m→0, 2h→1, 8h→2, 32h→3, 30d correct | closed form |

**`format.test.ts`**
| # | Test | Guards |
|---|------|--------|
| 22 | humanize: 0, 59s, 60s, 59m, 60m, 2h, 23h59m, 24h, 1610m, **and negative clamps** | display |

Deleted from the v2 list: the two tests for the 5m rung (Q2 removed it) and
"never returns a timestamp in the past" (it contradicts the cold-start case).

## Failure modes

| # | Failure | Severity | Response |
|---|---|---|---|
| F1 | `~/.claude/sessions/` shape drifts after a CC upgrade | HIGH | validate on read; degrade to CLI; `doctor` names it |
| F2 | Notification storm | **CRITICAL** | escalating ladder + `lastNotifiedAt` in state. A tool that spams gets muted, and muted returns you to 22h. This is the failure that kills the product. |
| F3 | User mutes globally and forgets | **CRITICAL** | **CORRECTED.** The claim "no global mute exists" was false. macOS ships one: System Settings > Notifications > <app> > Off, invisible to us and permanent. Refusing an in-product mute does not remove the mute, it moves it somewhere undetectable. Response: own the bundle id (N1), detect non-delivery (N2), and offer `agentview snooze <name> 4h` so the escape hatch is one we control and that expires. |
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

---

<!-- AUTONOMOUS DECISION LOG -->
# Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|-------|----------|-------|-----------|-----------|----------|
| 1 | 0 | Language: TypeScript on Bun, not Go | Taste | P3 pragmatic | go/cargo absent; bun present; `bun build --compile` verified to give the same single-binary story | Go + Bubble Tea (doc's pick) |
| 2 | 0 | Mode: SELECTIVE EXPANSION | Mechanical | autoplan override | greenfield would default to EXPANSION; override logged | EXPANSION |
| 3 | 1 | C1: plan solves a proxy problem | Taste | P1 completeness | 1367min blocked proves a dashboard you must open cannot catch it | keep TUI-first order |
| 4 | 1 | Approach C over A | Taste | P1+P5 | ships the measured fix and a usable interface the same night | A (TUI-first), B (notify-only) |
| 5 | 1 | E5 `doctor` into scope | Mechanical | P2 blast radius | <1d CC, mitigates the named portability failure | defer |
| 6 | 1 | C5 self-logging into scope | Mechanical | P1 | a daemon with no log is a silent failure by construction | defer |
| 7 | 1 | E1-E4 deferred to TODOS.md | Mechanical | P3 | outside blast radius | include |
| 8 | 1 | F9 notification storm → CRITICAL | Mechanical | P1 | muting returns the user to the 22h failure; it is the product-killing mode | keep as HIGH |
| 9 | 1* | **v1 killed; narrow to neglect detection** | **User Challenge** | n/a | every wedge verified occupied against live sources; user chose the narrowing | build v1 as written |
| 10 | 2 | Design phase skipped | Mechanical | evidence | 1 UI-scope match ("File layout"), below 2+ threshold | run design review |
| 11 | 2.5 | D1 empty-state proof-of-life | Mechanical | P1+P5 | monitoring tool whose value moment needs a live failure has no hello world | ship as-is |
| 12 | 2.5 | D2 daemon lifecycle verbs + launchd | Mechanical | P1 | v2 reintroduced v1's own bug one layer down | leave to the user |
| 13 | 2.5 | D3 mute by name prefix | Mechanical | P5 explicit | a UUID is unavailable at the moment of annoyance | mute by id |
| 14 | 2.5 | D4 three error strings verbatim | Mechanical | P1 | principle: problem + cause + fix | leave unspecified |
| 15 | 2.5 | D5 optional config file | Taste | P4 vs P5 | escape hatch (5 lines) vs shipping the guess and learning from a week of use | hardcode only |
| 16 | 2.5 | D6 README trust section | Mechanical | P1 | reads another tool's internals + runs a daemon; must be stated | omit |

\* Decision 9 was raised mid-run rather than at the gate because it invalidated the
premise of the three remaining phases. Reviewing craftsmanship on a plan whose wedge
is occupied is process theater. The user chose the narrowing explicitly.

## Taste decisions queued for the Final Gate

| # | Decision | Recommended | Alternative | Downstream if you pick the alternative |
|---|----------|-------------|-------------|---------------------------------------|
| T1 | Language | TypeScript on Bun | Go + Bubble Tea | You install Go tonight. Better long-term TUI ecosystem, but v2 has no TUI, so the advantage is mostly gone. |
| T2 | Milestone order | notify-first (Approach C) | TUI/list-first | You get a screenshot sooner for the README, and the 22h fix later. |
| T3 | Config escape hatch (D5) | ship optional config.json | hardcode the guess | Hardcoding forces you to feel the wrong thresholds, which is how you learn the right ones. Genuinely defensible. |

---

# DX DUAL VOICES — outside review + consensus

Codex: `[codex-unavailable: binary not found]`. Claude subagent ran. Tag: `[subagent-only]`.

```
DX DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                          Primary  Subagent  Consensus
  ──────────────────────────────────  ───────  ────────  ─────────
  1. Getting started < 5 min?         no 2/10  no 4/10   CONFIRMED (fails)
  2. CLI naming guessable?            no 6/10  no 4/10   CONFIRMED (fails)
  3. Error messages actionable?       no 1/10  no 2/10   CONFIRMED (fails)
  4. Docs findable & complete?        no 3/10  no 3/10   CONFIRMED (fails)
  5. Upgrade path safe?               no 3/10  no 1/10   CONFIRMED (fails)
  6. Dev environment friction-free?   no 4/10  no 3/10   CONFIRMED (fails)
═══════════════════════════════════════════════════════════════════
6/6 CONFIRMED. Zero disagreements. Overall: primary 3.6/10, subagent 3.0/10.
```

Both voices independently reached the same verdict: the detection half is sound and
the telling half is unbuilt. 269 lines about detecting neglect, four about telling
the user, and the telling is the entire product.

## Findings the outside voice caught that the primary pass missed

All verified against this machine before acceptance.

**N1 — CRITICAL: the notification is misattributed.** `osascript -e 'display
notification'` delivers under `com.apple.scripteditor2`. Every escalation arrives as
**Script Editor**, with Script Editor's icon, and appears in System Settings under a
name the user never installed. A product whose value is *trustworthy repeated
interruption* cannot be anonymous.
**Fix, accepted:** ship a minimal `agentview.app` bundle in the formula (~40KB:
`Info.plist` + helper), own bundle id `dev.<you>.agentview`, post through it.

**N2 — CRITICAL: `osascript` exits 0 whether or not the notification displayed.**
Notifications off, Focus filtering, or alert style "None" all produce silent success.
The daemon writes "notified erp-00 at 8h" to its log and the user saw nothing.
**F4 was the wrong worry: the daemon living silently is worse than dying, because the
log lies.**
**Fix, accepted:** `agentview doctor` performs a delivery round-trip — post with a
known identifier, read it back, confirm `presented=1`, exit non-zero with the System
Settings deep link if it cannot. Also read `~/Library/DoNotDisturb/DB/Assertions.json`
and report an active Focus.

**N3 — CRITICAL: F3 was false.** See the corrected failure table above.

**N4 — HIGH: Focus swallows exactly the case this was built for.** "You were asleep
or in a meeting" is precisely when DND is on. `display notification` cannot request
`interruptionLevel: .timeSensitive`; an app bundle can.
**Fix, accepted:** request Time Sensitive from the bundle; on wake, re-post the
highest rung rather than counting a suppressed notification as delivered.

**N5 — HIGH: fan-out storm.** F2 covers repeat-over-time, not seven sessions crossing
a rung in the same minute. Seven simultaneous banners is a plausible Monday.
**Fix, accepted:** coalesce to one notification per tick. Individual only when count
is 1.

**N6 — HIGH: the notification is a dead end.** Clicking it opens Script Editor. The
tty for the blocked pid is one `ps -o tty` away.
**Fix, accepted:** click focuses the terminal window for that pid. v2 excluded focus
as "already shipped by claude-code-monitor" — that is a competitive argument, not a
DX one. Do not ship an interruption with no resolution. Reuse, do not rebuild.

**Q1 — `quiet_hours`, the best idea in the review.** Let the ladder keep counting
overnight and deliver one honest *"erp-00 waited 9h overnight"* at 07:30, instead of
a 3am banner into a silenced Focus. That is this product's best moment and the plan
missed it entirely. **Accepted.**

**Q2 — drop or default-off the 5m rung.** Five minutes is a coffee, not neglect, and
it is the rung most likely to fire during active work and trigger the mute that kills
the product. Ladder becomes `30m / 2h / 8h / daily`. **Accepted.**

**Q3 — `brew services`.** Already in use on this machine for redis. Ship a formula
with a `service do` block so `brew services start agentview` works. **Accepted**,
alongside `agentview start` for non-brew installs.

**Q4 — binary size and Gatekeeper.** `bun build --compile` emits 50-100MB. Via a
formula it runs; via a hand-downloaded release tarball it is quarantined
("developer cannot be verified"). **Accepted:** state the size in the README and
include the `xattr -d com.apple.quarantine` line before someone files it as a bug.

**Q5 — `mute` → `snooze <name> <duration>`.** "Mute" implies the permanence the
design explicitly refuses to grant. **Accepted**, with name-prefix resolution,
ambiguity errors, and the resolved target echoed back:
`Snoozed erp-00 (c7dca696) until 18:31.`

## Corrections to the primary DX pass

| Primary claim | Corrected |
|---|---|
| "Title is optional; `erp-00` + `22h` is actionable" | False. `erp-00` vs `erp-0e` differ by one character and one is the blocked one. cwd is mandatory. |
| M1 mock showing 3 blocked sessions | Fabricated. One session is `waiting`. Mock replaced with the real single row. |
| F3 "no global mute exists" | False. macOS ships one and it is invisible to us. |
| D4 error strings | Superseded by the outside voice's versions, which state what the *user loses* rather than what broke internally. |

## Revised DX scorecard

| # | Dimension | Before | After accepted fixes |
|---|-----------|--------|----------------------|
| 1 | Getting started / TTHW | 2 | 8 (`doctor --demo` makes it 60 verifiable seconds) |
| 2 | CLI naming & ergonomics | 4 | 8 (lifecycle verbs, `snooze`, `logs`, `--json`) |
| 3 | Error messages | 1 | 8 |
| 4 | Docs | 3 | 7 (trust section, `.key` statement, uninstall) |
| 5 | Upgrade path | 1 | 7 (`brew services`, `status` shows staleness) |
| 6 | Escape hatches | 4 | 8 (config.toml with `quiet_hours`) |
| 7 | Debuggability | 8 | 9 (`doctor` gains the delivery round-trip) |
| 8 | Trust & uninstall | 2 | 8 (`uninstall` command, `.key` glob + test) |
| 9 | Notification text | 2 | 8 (absolute time, project, next action) |

**Overall DX: 3.0/10 → 7.9/10 with all accepted fixes.**

## Highest-leverage change (both voices agree)

**Own the notification and prove it landed.** A signed `agentview.app` bundle with its
own bundle id, a Snooze action button, click-to-focus-the-tty, and a `doctor` that
posts a test notification and reads it back to confirm delivery.

That single change fixes N1, N2, N3, N4, N6, and the snooze scavenger hunt, and turns
TTHW from unbounded into sixty verifiable seconds. Everything else is downstream of
the fact that today this product's only output is anonymous, silently droppable, and
leads nowhere.

## Phase 2.5 complete

> DX overall: 3.0/10 → 7.9/10 with fixes. TTHW: unbounded → ~60s.
> Codex: unavailable. Claude subagent: 15 findings, 5 critical.
> Consensus: 6/6 confirmed, 0 disagreements.
> Passing to Phase 3 (Eng Review).

---

# ENG REVIEW (Phase 3 — /autoplan)

## Section 1: Architecture

```
                       ┌──────────────────────────────┐
                       │ ~/.claude/sessions/*.json    │  external, undocumented
                       │ (glob *.json ONLY — *.key    │  drwx------
                       │  files live here at 0600)    │
                       └──────────────┬───────────────┘
                                      │
                    ┌─────────────────▼──────────────────┐
        ps -eo ────►│  sources.ts                        │◄──── claude agents --json
        (ONE call)  │  read · validate shape · liveness  │      (fallback + 30s reconcile)
                    │  pid-reuse guard · dead-pid filter │
                    └─────────────────┬──────────────────┘
                                      │ RawSession[]
                    ┌─────────────────▼──────────────────┐
                    │  sessions.ts                       │
                    │  → Blocked[] sorted by blockedMs   │
                    └───────┬───────────────────┬────────┘
                            │                   │
              ┌─────────────▼──────┐   ┌────────▼─────────┐
              │ duration.ts        │   │ render (cli.ts)  │
              │ PURE. no I/O.      │   │ one-shot output  │
              │ humanize()         │   └──────────────────┘
              │ nextNotifyAt()     │
              └─────────┬──────────┘
                        │ (pure fn, state injected)
              ┌─────────▼──────────┐
              │ watch.ts (daemon)  │
              └──┬──────────────┬──┘
                 │              │
      ┌──────────▼───┐   ┌──────▼─────────────────────┐
      │ state.ts     │   │ notify.ts                  │
      │ atomic write │   │ agentview.app bundle (N1)  │
      │ tmp+rename   │   │ delivery verify (N2)       │
      │ GC on write  │   │ coalesce (N5)              │
      └──────────────┘   └────────────────────────────┘
```

**Layering verdict: sound.** `duration.ts` is pure with state injected, which is the
right call and makes the ladder testable without touching disk. One coupling fix:
`watch.ts` must own the clock. Pass `now` into every pure function rather than letting
`duration.ts` call `Date.now()`, or half the edge cases below become untestable.

## E1 — CRITICAL (verified): `procStart` and `ps lstart` are in different timezones

The pid-reuse guard is necessary (see E2) and the obvious implementation is broken.

```
pid 80615  json procStart: Mon Sep  7 04:49:51 2026   <- UTC, formatted as local
           ps -o lstart= : Mon Sep  7 10:19:51 2026   <- actually local
                                          delta = 5:30 = the machine's TZ offset
```

Verified on two independent pids, both exactly the TZ offset. A naive string or
`new Date()` comparison mismatches on **every** session, so every row is treated as a
recycled pid and dropped. The tool then reports "nothing blocked" permanently while
appearing to work correctly.

**Fix:** parse `procStart` as UTC explicitly, parse `lstart` as local, compare epoch
values with a ±2s tolerance. **Test it against a fixture from a machine in a non-UTC
timezone** — on a UTC machine this bug is invisible, which is exactly how it ships.

## E2 — CRITICAL: state must be keyed on `sessionId + blockedSince`, not `sessionId`

A session that flaps `waiting → busy → waiting` gets a fresh `statusUpdatedAt`, so
`blockedMs` resets and the ladder restarts. But `lastNotifiedMs` keyed on `sessionId`
alone carries over from the previous block, so the new block is suppressed until the
old ladder position is exceeded.

Concretely: a session blocked 8h, answered, then blocked again fires nothing for the
next 8 hours. **The exact failure the product exists to prevent.**

**Fix:** key state on `${sessionId}:${blockedSince}`. A new block is a new key with no
history. This also fixes pid reuse and makes GC trivial.

## E3 — HIGH: multiple rungs crossed in one tick

Laptop sleeps 9 hours. On wake `blockedMs` jumps past 30m, 2h, and 8h in a single
poll. A naive loop fires three notifications at once.

**Fix:** `nextNotifyAt` returns the **highest rung crossed**, never a queue. Fire once,
record that rung. Combined with N4 (re-post highest rung on wake), the user gets one
honest "waited 9h overnight" — which with `quiet_hours` is the product's best moment.

**No listed test covers this.** Added as T17.

## E4 — HIGH: clock movement makes `blockedMs` negative

`blockedMs = now - statusUpdatedAt` with wall-clock values. An NTP correction backward
yields a negative duration; `humanize(-3000)` produces nonsense and the ladder
comparison silently never fires.

**Fix:** clamp at 0, and log once when a negative appears (it indicates clock skew
worth surfacing in `doctor`). DST does not affect epoch ms; NTP does.

## E5 — MEDIUM: N process spawns per poll

The plan implies `ps -p <pid>` per session. At 7 sessions that is 7 spawns per tick;
the plan's own scaling note contemplates more.

**Measured:** one `ps -eo pid=,lstart=,comm=` covering every process costs **19ms**
total. Do that once per tick, index by pid, and get the E1 reuse guard from the same
output for free.

## E6 — MEDIUM: `state.json` grows without bound

Every block of every session ever seen accrues a key, and E2's compound key makes keys
strictly more numerous.

**Fix:** GC on write. Drop entries whose sessionId is not in the current live set AND
whose timestamp is older than 7 days. Bounded by session churn, not by uptime.

## E7 — MEDIUM: concurrent state access

The daemon writes on the poll loop; the one-shot CLI reads whenever the user runs it.

**Fix:** write to `state.json.tmp` then `rename()`. Atomic on APFS, so a reader sees
either the old or new file and never a torn one, and power loss mid-write leaves the
previous good file. **A lockfile is not needed for this** and adds a stale-lock failure
mode. The lockfile in F5 is for single-daemon enforcement only — different problem,
keep it, but do not use it to guard state writes.

## E8 — MEDIUM: Bun daemon longevity

`bun build --compile` for a process meant to run for weeks. Bun 1.3.13 verified
present. Unknowns: heap growth across tens of thousands of poll cycles, and file
handle behavior on a directory re-globbed every 250-500ms.

**Fix, cheap:** `KeepAlive` in the LaunchAgent already restarts on death. Add
`process.memoryUsage().rss` to `agentview status` output and log it hourly. If RSS
climbs monotonically over a week, that is data, and restarting a daemon nightly is an
acceptable v0.1.0 answer. Do not pre-optimize; do make it observable.

## Section 3: Test diagram

| # | Codepath / flow | Test type | Exists? |
|---|---|---|---|
| 1 | glob `*.json`, never `*.key` | unit + assertion | **GAP → T19** |
| 2 | shape validation, missing `statusUpdatedAt` | unit | T9 |
| 3 | dead pid excluded | unit | T8 |
| 4 | **pid reused, TZ-correct comparison** | unit + non-UTC fixture | **GAP → T20** |
| 5 | malformed JSON in one file | unit | T11 |
| 6 | CLI fallback when dir absent | unit | T10 |
| 7 | sort by blockedMs desc, stable ties | unit | T12 |
| 8 | `waiting` only (+ idle ladder) | unit | T7 |
| 9 | humanize boundaries | unit | T1 |
| 10 | ladder fires at each rung, once | unit | T2-4 |
| 11 | blocked-before-daemon-start | unit | T5 |
| 12 | **multi-rung crossed in one tick** | unit | **GAP → T17** |
| 13 | **negative blockedMs (clock skew)** | unit | **GAP → T18** |
| 14 | **flap waiting→busy→waiting re-notifies** | unit | **GAP → T21** |
| 15 | mute expiry at 24h | unit | T13 |
| 16 | state absent / corrupt | unit | T14-15 |
| 17 | **state GC drops stale keys** | unit | **GAP → T22** |
| 18 | **atomic write leaves no torn file** | unit | **GAP → T23** |
| 19 | single-daemon lockfile | integration | T16 |
| 20 | notification delivery verified | manual/doctor | N2, manual |
| 21 | coalesce ≥2 blocked into one | unit | **GAP → T24** |

**8 gaps found. All 8 accepted as additions (P1 completeness).** Test count 16 → 24.

The most important is **T20**: E1 is invisible on a UTC machine, so it must be tested
against a fixture captured in a non-UTC timezone or it ships broken to everyone except
the author, who is in IST and would catch it — and everyone in UTC would not.

## Failure modes — critical gaps

| # | Gap | Severity |
|---|---|---|
| E1 | TZ skew silently drops every session | **CRITICAL** |
| E2 | re-blocked session suppressed for hours | **CRITICAL** |
| E3 | notification burst after sleep | HIGH |
| E4 | negative duration disables the ladder | HIGH |

E1 and E2 both produce **silent wrong behavior that looks like correct behavior**,
which is the worst class for a tool whose entire job is telling you about something
you cannot otherwise see.

## NOT in scope (Eng)

Unchanged from CEO/DX, plus: no retry/backoff layer for `ps` or `claude` (a failed
tick is fine, the next one is 250ms away); no IPC between CLI and daemon (state file
is the interface); no cross-machine sync.

## What already exists

`statusUpdatedAt` (duration), `nameSource` (untitled flag), `procStart` (pid-reuse
guard), `messagingSocketPath` (deferred, v0.2 door), `claude agents --json` (fallback),
`brew services` (daemon supervision), LaunchAgent `KeepAlive` (F4 restart).

---

# ENG DUAL VOICES — outside review + consensus

Codex: `[codex-unavailable: binary not found]`. Claude subagent ran. Tag: `[subagent-only]`.

```
ENG DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                          Primary  Subagent  Consensus
  ──────────────────────────────────  ───────  ────────  ─────────
  1. Architecture sound?              partial  NO        DISAGREE → resolved for subagent
  2. Test coverage sufficient?        NO       NO        CONFIRMED (fails)
  3. Performance risks addressed?     partial  NO        CONFIRMED (fails)
  4. Security threats covered?        YES      partial   DISAGREE → resolved for subagent
  5. Error paths handled?             NO       NO        CONFIRMED (fails)
  6. Deployment risk manageable?      partial  NO        CONFIRMED (fails)
═══════════════════════════════════════════════════════════════════
4/6 CONFIRMED. 2 DISAGREE, both resolved in the subagent's favour on evidence.
Engineering readiness: 4/10.
```

## The subagent beat the primary pass. Findings adopted wholesale.

**A1 — CRITICAL: there is no decision module, so the product logic will live untested
inside the daemon loop.** The four contracts (`blocked`, `humanize`, `nextNotifyAt`,
`isMuted`) are all leaves. Nothing composes them. "Given the sessions, the state, the
config, and now — what do I emit and what do I persist?" has no name, no file, and no
test, so it will be written inline in `while(true)`. Every hard case lives there.

**This supersedes the primary pass's architecture verdict of "layering sound."**

```ts
// tick.ts — pure. No I/O, no Date.now(), no side effects. Test this hardest.
function tick(i: {now:number; sessions:Session[]; state:State; config:Config}):
  {notifications:Notification[]; nextState:State; logLines:string[]}
```

Daemon becomes ~8 lines. Every edge case becomes a table-driven unit test.

**A2 — `nextNotifyAt(blockedMs, lastNotifiedMs)` cannot be implemented as written.**
`blockedMs` is a duration; test T6 proves the return is an absolute epoch. You cannot
get an epoch from a duration without `now`, which is not a parameter. Both params are
`number` with the same `Ms` suffix but different meanings — a swapped-argument bug the
compiler cannot catch. Replace with `dueAt(blockedSince, rung)` and
`highestDueRung(blockedSince, now)`, both pure and anchored to `blockedSince` so they
are restart-invariant.

**A3 — T6 contradicts T5.** "Never returns a timestamp in the past" is exactly wrong:
the cold-start case *requires* a past due-time, which is the signal to fire now.
Clamping to the future breaks success criterion 2. **Delete T6.**

**A4 — the persisted record must carry the rung, not just the timestamp:**

```ts
interface SessionState {
  sessionId: string; blockedSince: number;  // ← ladder key
  lastRung: number;                          // -1 = none delivered
  lastNotifiedAt: number | null; lastSeenAt: number;
}
```

**Correction to primary E2:** the primary pass said a re-blocked session would be
*suppressed*. Wrong direction. With `lastNotifiedAt` only,
`nextNotifyAt(2min, 3h_ago)` sees "3h since we last notified" and **fires immediately
on a two-minute-old block.** Every answered-then-reblocked session nags instantly.
That is F2, the product-killing mode, reachable in ordinary use.

**C1 — CRITICAL: `snooze` is guaranteed to be lost, at the worst moment.** Daemon does
read-modify-write across a whole tick; the CLI snoozes *because a notification just
fired*, i.e. inside that same tick. The daemon's write erases it, and it re-notifies
5s later. A snooze that does not work is the exact trigger for the macOS global mute
that N3 says is unrecoverable.

**Fix — remove the shared writer rather than lock it.** Supersedes the primary pass's
atomic-write answer, which is necessary but not sufficient:

```
~/.agentview/state.json     daemon writes, CLI reads
~/.agentview/snoozes.json   CLI writes, daemon reads
```
Zero locks, zero races, both trivially testable.

**C2 — CRITICAL: T15's prescribed behaviour causes the plan's own CRITICAL failure.**
"State corrupt → reset, log, continue" discards every `lastRung` and every snooze, so
the next tick re-fires every blocked session at its highest rung and voids every
snooze. **A crash produces a notification storm.**
**Fix:** keep `state.json.bak`; on parse failure try it first; if you must reset,
**seed rather than blank** — set `lastRung = highestDueRung(...)` and
`lastNotifiedAt = now` for every currently-blocked session. Lose one notification, not
emit a burst. **Degrade quiet, never loud.**

**C3 — F8 pid reuse, with a better fix than the primary pass found.** Orphan `.key`
files for dead pids 550/39340/68432 prove cleanup is not universal; highest live pid
93111 against a 99999 wrap is days away, not months. A stale `waiting` file whose pid
gets reused escalates forever with nothing to answer.
**Fix supersedes primary E1:** do not parse `procStart` at all. The JSON already
carries `startedAt` as **epoch ms**. Compare it to parsed `ps lstart` with a 5s
tolerance (1s skew measured), and require `comm` to contain `claude`. Plus a hard cap:
stop escalating after 7 continuous days on a byte-identical file, and tell `doctor`.

**C4 — `process.kill(pid,0)` instead of spawning `ps`.** Measured by the subagent:
**100,000 calls in 43.9ms**, no subprocess. Supersedes primary E5's "one `ps` per
tick" — spawn `ps` only for the F8 start-time cross-check.

**C5 — N2 IS EMPIRICALLY WRONG. The accepted "highest-leverage fix" is a false-negative
machine.** The subagent posted three notifications that visibly delivered as banners.
All three read `presented = 0`.

Independently re-verified here on the aggregate: **64 rows `presented=0`, 8 rows
`presented=1`.** If that column meant "delivered," 64 notifications silently failed.
It tracks *currently presented* — a banner that auto-dismisses after ~5s reads 0.

**`agentview doctor` as accepted would exit non-zero on a perfectly healthy machine,
which is worse than having no check: it teaches the user to ignore doctor.**

**Corrected fix:** check **record existence** — matching uuid or decoded title with
`delivered_date` inside the last N seconds — never `presented`. Note also that the
`data` column is a **binary plist**, so correlation needs bplist decoding, and reading
the DB at all requires **Full Disk Access**, which a launchd-launched binary will not
have. Detect the FDA case explicitly and print the grant instruction rather than
reporting a delivery failure.

**C6 — N1's cost was badly underestimated.** "~40KB Info.plist + helper" is wrong. Time
Sensitive (N4) + an action button (Snooze) + a click handler (N6) require
`UNUserNotificationCenter` from a running bundle, which means a **compiled ObjC/Swift
helper linking UserNotifications.framework, plus codesign, plus notarization.** The
"TypeScript on Bun, one toolchain" story becomes "Bun + Swift + codesign + notarize."
That is not reflected in T1's language trade-off, the milestones, or the file layout.

**C7 — Bun measured, not assumed.** Binary **63,072,928 bytes**. RSS over 30,000 ticks:
21.5 → **39.3 MB** without a subprocess; 23.1 → **81.2 MB** with `Bun.spawn(ps)` per
tick. Both plateau — **no unbounded leak**. But spawning doubles resident memory for a
daemon whose job is stat-ing seven small files, which C4 removes. Mandate: every spawn
`await p.exited` or use `spawnSync`, or the fd and zombie leak silently under a
1,048,576 fd limit. Add a 24h soak asserting RSS at t=24h within 20% of t=1h.

**C8 — scope was never re-costed.** ~20 features accepted across three phases
(D1-D6, N1-N6, Q1-Q5) and the File layout, Function contracts, and Test plan sections
were never regenerated. The plan still boasts "seven source files" while carrying more
accepted scope than v1 had. Missing modules with no home: `log.ts`, `launchd.ts`,
`config.ts`, `focus.ts`, `ladder.ts`, the `.app` build target, and a persisted history
for "longest wait today" (which is an event log with daily rollup, not "one counter").
**Realistic estimate: 5-8 days, not one night**, driven almost entirely by N1.

**C9 — L10, timers vs polling.** If the daemon uses `setTimeout(dueAt - now)`, the
timer is monotonic and an 8h sleep delivers 16h late. **Mandate: poll on a fixed short
interval and recompute from wall clock every tick. Never `setTimeout` beyond one tick.**

**C10 — L8, DST breaks `quiet_hours`, and the author cannot reproduce it.**
Asia/Kolkata has no DST. Every US/EU user hits it twice a year. Same class as the TZ
bug above: invisible locally, broken for everyone else. Needs
`TZ=America/New_York` fixtures at the 2026-03-08 and 2026-11-01 transitions.

**C11 — F13, `waitingFor` value space assumed.** Only `"input needed"` observed. If a
short-lived tool-approval state also sets `waiting` under a different `waitingFor`, the
ladder starts on prompts that resolve in 8 seconds. False positives are the worst kind
here. `doctor` should record every distinct value seen; escalate only on an allowlist.

**C12 — the `.key` test the plan mandates in prose is not in the numbered list.** The
plan's most safety-critical assertion exists only as narrative. Add it as a numbered
test.

## Revised test count

Primary pass: 16 → 24. Subagent found 14 more uncovered paths, including the entire
`tick()` layer, quiet-hours DST, the snooze race, corrupt-state seeding, and the
mandated `.key` assertion. **Final: 24 → 33**, and two existing tests (T2, T3) test the
5m rung that Q2 deleted.

## Phase 3 complete

> Codex: unavailable. Claude subagent: 30+ findings, 6 critical.
> Consensus: 4/6 confirmed, 2 disagreements both resolved for the subagent on evidence.
> Engineering readiness 4/10. Single most likely production bug: state keyed on
> `sessionId` alone with only `lastNotifiedAt` persisted — it produces four separate
> silent wrong-notification bugs and none of the 16 original tests catch any of them.
> Passing to Phase 4 (Final Gate).
