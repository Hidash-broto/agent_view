# PLAN: agentview v0.1.0

Design doc: `~/.gstack/projects/terminal-with-tab-name/hidash-unknown-design-20260910-071553.md` (APPROVED)
Branch: main
Status: DRAFT — under /autoplan review

## What we're building

A terminal UI that lists every live Claude Code session with a **real name**, its
**state**, and **how long it has been in that state**, and lets you jump to the
window running it.

The product is one join: session state (which already exists) against session
identity (which exists but is not surfaced).

## Stack decision

**TypeScript on Bun**, shipped as a standalone binary via `bun build --compile`.

This reverses the design doc's Go recommendation, on evidence gathered after it was
written: `go` and `cargo` are **not installed** on this machine; `bun 1.3.13` and
`node v22.22.3` are. The doc preferred Go only for the single-static-binary
distribution story and dismissed TypeScript because it "drags Node along as a runtime
dependency." `bun build --compile --outfile=agentview ./src/cli.ts` produces a
standalone executable, which voids that objection. Same distribution story, zero
toolchain install.

TUI layer: raw ANSI to start (M2-M3). Ink is a fallback if hand-rolled rendering
gets unpleasant, not a starting assumption. See Open Question 2.

## Milestones

### M0 — Verification gate (BLOCKING, no code)

Three checks that can each invalidate work below. Do these first.

| # | Check | If it fails |
|---|---|---|
| M0.1 | Run `claude agents` (no `--json`) in a real TTY. Does it show real titles? | If yes, agentview's differentiator drops to time-in-state + jump-to-window. Rewrite the README pitch, keep the build. |
| M0.2 | Put a session into a permission prompt. Time how long until `status` flips to `waiting` in `~/.claude/sessions/<pid>.json`. | If > 2s, success criterion 4 is unmeetable as written. Relax it or move to the `Notification` hook. |
| M0.3 | Confirm `~/.claude/sessions/` exists and matches `claude agents --json` on a second machine or after a Claude Code upgrade. | If it diverges, demote Source 0 to opportunistic and make the CLI primary. |

**M0 is a gate, not a suggestion.** Every milestone below assumes all three pass.

### M1 — The join, as a library

`sessions()` returns the fully resolved list. This is the entire product; everything
after M1 is a view over it.

### M2 — Static render

`agentview` prints the sorted table once and exits. Verifies sort order, the title
fallback chain, and time-in-state against real sessions before any loop exists.

### M3 — Live TUI

Alt-screen, 250ms poll, keyboard nav.

### M4 — Jump to session

`Enter` focuses the Terminal.app window running the selected session.

### M5 — Notifications

Fire on transition into `waiting`. Never on steady state.

### M6 — Release

`bun build --compile`, GitHub Actions on tag, Homebrew tap.

## File layout

```
src/
  cli.ts                  entry; arg parsing; dispatch to render or watch
  sessions/
    types.ts              Session, SessionState, TitleSource
    sources.ts            Source 0 (~/.claude/sessions) + Source 1 (claude agents --json)
    titles.ts             transcript lookup + fallback chain
    index.ts              sessions(): the join. The product.
  focus/
    terminal.ts           AppleScript window focus by tty
  ui/
    format.ts             row formatting, truncation, disambiguation
    render.ts             static table (M2)
    watch.ts              alt-screen loop + keys (M3)
  notify/
    notify.ts             transition detection + macOS notification (M5)
test/
  sources.test.ts
  titles.test.ts
  sessions.test.ts
  format.test.ts
  fixtures/               copied real jsonl tails + sessions json, anonymized
```

## Types

```ts
type SessionStatus = 'waiting' | 'busy' | 'idle';
type TitleSource   = 'custom' | 'ai' | 'prompt' | 'derived';

interface Session {
  sessionId: string;
  pid: number;
  cwd: string;
  kind: 'interactive' | 'background';
  status: SessionStatus;
  waitingFor?: string;
  statusUpdatedAt: number;   // ms epoch; from Source 0
  startedAt: number;
  title: string;
  titleSource: TitleSource;  // 'derived' means we have no real name
  tty?: string;              // absent for background sessions
  transcriptPath?: string;
}
```

## Function contracts

### `sources.ts`

```ts
// Source 0. Reads ~/.claude/sessions/*.json. ~2ms.
// Filters out entries whose pid is no longer alive.
async function readSessionDir(): Promise<RawSession[]>

// Source 1. Spawns `claude agents --json`. ~140ms. Fallback + reconcile.
async function readAgentsCli(): Promise<RawSession[]>

// Primary entry. Source 0 with Source 1 reconcile every RECONCILE_MS (30_000).
// If Source 0 is missing or its shape fails validation, falls back to Source 1
// permanently for the process lifetime and logs once.
async function readSessions(opts?: { forceCli?: boolean }): Promise<RawSession[]>
```

### `titles.ts`

```ts
// Fast path: derive slug per cli.js rule -> [^a-zA-Z0-9] => '-', 200-char cap.
// Correctness path: glob ~/.claude/projects/*/<sessionId>.jsonl at depth 2 only
// (depth 2 skips subagents/ and memory/).
async function findTranscript(sessionId: string, cwd: string): Promise<string | null>

// Fallback chain. custom-title (TAIL scan) > ai-title (HEAD scan) > last-prompt
// (TAIL scan) > null. ai-title is immutable once written, so it is cached
// permanently by sessionId and never re-read.
async function resolveTitle(sessionId: string, cwd: string):
  Promise<{ title: string; source: TitleSource } | null>
```

### `index.ts`

```ts
// The join. Everything else is a view over this.
async function sessions(): Promise<Session[]>
```

### `format.ts`

```ts
// Strips a leading slash-command token and renders it as a prefix:
// "/plan-eng-review shall we plan this" -> "plan-eng-review · shall we plan this"
function formatPromptTitle(raw: string, width: number): string

// If two visible rows would render identical text, append cwd basename to both.
// Runs over the whole visible set, not per row.
function disambiguate(rows: Session[]): Row[]

// 1367 -> "22h", 369 -> "6h9m", 4 -> "4m", 0 -> "now"
function humanizeMinutes(mins: number): string
```

## Test plan

Fixtures are anonymized copies of real records from this machine, committed under
`test/fixtures/`. No network, no live `claude` spawn in unit tests.

**`titles.test.ts`**
1. `custom-title` at line 1346 of 1353 wins over `ai-title` at line 450. Guards the
   head-vs-tail scan bug directly.
2. `ai-title` repeated 121 times with one unique value resolves to that value.
3. Session with no `ai-title` and a `last-prompt` resolves to `source: 'prompt'`.
4. Session with a `last-prompt` record **missing the `lastPrompt` field** (9 of 4029
   real records are like this) does not throw and falls through to `derived`.
5. Path `/tmp/my_app.v2 test` maps to `-private-tmp-my-app-v2-test`, not
   `-tmp-my_app.v2 test`. Guards the wrong slug rule.
6. A cwd whose slug exceeds 200 chars is NOT resolved by derivation; the glob path
   finds it instead.
7. Glob does not match `<project>/<sessionId>/subagents/agent-*.jsonl`.

**`sources.test.ts`**
8. A `~/.claude/sessions/<pid>.json` whose pid is dead is excluded.
9. Source 0 missing entirely falls back to Source 1 and logs once, not per tick.
10. Source 0 present but missing `statusUpdatedAt` (shape drift after an upgrade)
    degrades to no-time-in-state rather than crashing.
11. Source 0 and Source 1 disagreeing on the pid set trusts Source 1 and logs.

**`format.test.ts`**
12. Two sessions both titled `/office-hours ...` in different cwds render distinctly.
13. Two sessions with the **same** title in the **same** cwd still render distinctly.
14. A 200-char title truncates without breaking the column layout.
15. `humanizeMinutes` boundaries: 0, 1, 59, 60, 61, 1439, 1440.

**`sessions.test.ts`**
16. Full join over fixtures produces correct sort: waiting, then busy, then idle.
17. A `kind: 'background'` session has no `tty` and is marked unfocusable.
18. Two sessions reporting the same tty are both marked unfocusable.

**Not unit tested, verified manually in M0/M4:** AppleScript focus, notification
delivery, real-time status flip latency.

## Failure modes

| # | Failure | Detection | Response |
|---|---|---|---|
| F1 | `~/.claude/sessions/` gone after upgrade | shape validation on read | fall back to CLI, log once, keep running |
| F2 | `claude agents --json` output shape changes | schema check | render titles only, banner "state unavailable" |
| F3 | `claude` not on PATH | spawn ENOENT | Source 0 only; no reconcile; banner |
| F4 | Transcript is 33MB | size check before read | bounded tail read, never full scan |
| F5 | AppleScript denied by TCC | non-zero exit + stderr | one-time message explaining Automation permission; copy tty to clipboard |
| F6 | Session dies between poll and focus | `ps -p` before AppleScript | remove row, no error dialog |
| F7 | Two sessions, same tty | detect in join | mark both unfocusable |
| F8 | Terminal.app not running (iTerm/tmux user) | `$TERM_PROGRAM` check | disable focus, state it once at startup |

## NOT in scope for v0.1.0

- iTerm2 and tmux focus backends. Terminal.app only.
- A `--json` output mode. No consumer exists.
- Filtering and search. Seven rows.
- Cost or token display. Different product.
- Attaching to or controlling sessions. agentview observes; it never writes.
- Windows and Linux. macOS only.

## What already exists (do not rebuild)

- **Session state**: `claude agents --json` and `~/.claude/sessions/*.json`.
- **State transitions as events**: Claude Code's `Notification` and `Stop` hooks.
  Not used in v0.1.0; the polling path is simpler and has no install step.
- **Manual naming**: `/rename` already sets `customTitle`. agentview must respect it,
  never override it, and should mention it in the README.
- **Title resolution semantics**: `Gt()` in `cli.js`. Mirror it rather than invent.

## Open questions

1. **M0.1 outcome.** Unknown until run in a TTY. Gates the README pitch, not the build.
2. **Raw ANSI or Ink for M3.** Starting raw. Ink if hand-rolled rendering costs more
   than an hour. Not a one-way door either way.
3. **`agentName` and `summary` storage location.** `Gt()` reads them; the transcript
   record types are not confirmed. Add to the chain once located.
4. **Notification mechanism.** `osascript -e 'display notification'` needs no
   permission prompt but is unstyled. `terminal-notifier` is nicer and is a dependency.
   Deferred to M5.
