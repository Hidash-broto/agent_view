# agentview

**Nothing tells you an agent has been blocked for 26 hours.**

Every Claude Code notifier alerts you at the *moment* a session blocks. If you were
asleep, in a meeting, or looking at another window, that alert is spent and nothing
ever raises it again.

agentview answers the question none of them ask: **what have I abandoned?**

```
$ agentview

  BLOCKED  26h  acme/erp      erp-00      input needed since Mon 08:56
  BLOCKED   6h  acme/billing  billing-a3  input needed since 04:56

  2 waiting. Oldest 26h.
```

That 26-hour row is real. It was measured on the author's machine while designing
this, and it gained four hours during the design session.

## What it is not

There are good session managers already, and this is not one of them. If you want a
list of your sessions, states, and a TUI to attach to them, use
[Agent of Empires](https://github.com/agent-of-empires/agent-of-empires),
[agent-deck](https://github.com/asheshgoplani/agent-deck), or the built-in
`claude agents`. They are better at that than this will ever be.

agentview does one thing those do not: **it sorts by how long you have ignored
something, and it tells you more than once.**

```
$ agentview watch

  agentview · watching for sessions you have forgotten
  ──────────────────────────────────────────────────────────

  Watching 3 Claude sessions across 2 projects.
  If one waits on you, I ping at 30s · 30m · 2h · 8h · 24h — then stop.
  Nothing to configure. Leave this tab open.

  ✓ Nothing is waiting on you.

    ● acme/erp       erp-00       working
    ○ acme/erp       erp-76       idle 65h  ← longest
    ○ acme/billing   billing-a3   idle 12m

  12:08:31  all clear · 3 sessions · checking every 5s · Ctrl-C to stop
```

and when one goes unanswered — with enough context to recognise it without
opening it:

```
   1 SESSION WAITING FOR YOU

    ▸ acme/erp  erp-00
      waiting 26h · input needed · since Mon 10:08 · branch fix/boot · PR #920
      you asked: can you do this same boot error problem in crm also.
      it replied: Decisive: `createApplicationContext` throws DI errors during…
      answer it, or:  agentview ack erp-0  ·  agentview show erp-0
```

`agentview show` expands that into the full last exchange.

## Install

```bash
git clone https://github.com/Hidash-broto/agent_view.git
cd agent_view
bun install
bun run build                    # produces ./agentview, a standalone ~60MB binary
cp agentview ~/.local/bin/       # or anywhere on your PATH
```

Check it: `agentview doctor` should print what it can see. No Homebrew tap yet.

## Use

```
agentview                    what is waiting, longest first
agentview --idle             also show sessions idle over 4h
agentview watch              run the notifier (Ctrl-C to stop)
agentview snooze erp 4h      quiet one session for a while
agentview ack erp            "I handled it" — silence this block for good
agentview unsnooze erp       undo either
agentview show erp           what this session is about: branch, PR, last exchange
agentview doctor             what it can see, and everything it touches
```

Names take a prefix, so `agentview ack erp` is enough. It resolves against the live
session list and tells you if the prefix is ambiguous, because `erp-00` and `erp-0e`
are one character apart and one of them is the blocked one.

## The escalation ladder

```
  blocked
     |
   30s  ── "erp-00 waiting 30s"      Blocked since 10:21.
     |                               ↑ answer within 30s and you hear nothing
   30m  ── "erp-00 waiting 30m"      Nothing since 10:21. Or: agentview ack erp-00
     |
    2h  ── "erp-00 waiting 2h"       Still blocked since 08:51.
     |
    8h  ── "erp-00 waiting 8h"       Still blocked since 02:51.
     |
   24h  ── "erp-00 waiting 26h"      Last reminder. Still blocked since Mon 08:57.
     |
   silent — still listed by `agentview`, never notified again
```

Change any of it in `~/.agentview/config.json` (optional, read if present):

```json
{ "ladder": ["30s", "30m", "2h", "8h", "24h"], "poll": "5s" }
```

`agentview doctor` prints the ladder actually in effect and where it came from.

**The ladder is finite on purpose.** agentview decides whether to nag you by reading
one field written by another program. We could not prove that field always clears
when you answer. Rather than trust it, the blast radius is bounded: five
notifications over two days, worst case, then silence. `agentview ack` is the manual
override, and it depends on nothing Claude Code does.

## What it reads and writes

- **Reads** `~/.claude/sessions/*.json` for session state. That directory also holds
  `*.key` files at `0600`; agentview globs `*.json` and never lists, opens, or logs
  anything else. [There is a test that asserts it.](test/sessions.test.ts)
- **Reads the tail of your transcripts** (`~/.claude/projects/*/<id>.jsonl`) to answer
  "which session is this, and what model is it on?" — the model, the branch, any PR,
  the last thing you asked, the last thing Claude said. Only the final ~256KB of a
  file is ever touched, cached so it is re-read only when the file grows, and the
  content is printed to your terminal and nowhere else. It is never written to the
  log. This covers every live session, not only blocked ones, because the model
  belongs on every row. If you would rather it did not, there is no flag for that yet
  — say so and it becomes one.
- **Writes** `~/.agentview/` — `state.json`, `snoozes.json`, `agentview.log`. Nothing else.
- **Sends** nothing. No network calls, no telemetry, no update check.
  Verify: `grep -rn 'fetch\|http' src/`

`agentview doctor` prints all of the above, every time.

## What it costs to leave running

Measured on an M-series MacBook Air, 6 live sessions, default 5s poll:

| | idle | with a session blocked |
|---|---|---|
| CPU | **0.015% of one core** (~0.5s/hour) | **0.034%** (~1.2s/hour) |
| Disk writes | 0 | **0** while nothing changes |
| `ps` spawns | 4/hour | 4/hour |
| Memory | ~57MB resident | ~62MB |

Three things make it cheap, and each was a real fix rather than a default:

- **State is only written when it actually changes.** The naive version fsynced
  `state.json` on every tick — 17,280 SSD flushes a day to rewrite identical bytes.
  It also needed `lastSeenAt` quantised to 5 minutes, because storing `now` verbatim
  made the state differ every tick and defeated the check.
- **`ps` is cached.** It exists only to catch a recycled pid, which can only happen
  when the set of pids changes. 720 fork+execs an hour became 4.
- **Transcript tails are cached on (mtime, size)**, so a busy session is re-read only
  when it actually grows.

The ~60MB resident is the embedded Bun runtime, not agentview's own data. That is the
honest cost of `bun build --compile`; a Go or Rust build would be a few MB.

## Known limitations in v0.1.0

- **Notifications say "Script Editor."** `osascript` posts under the scripting host,
  not under us. Owning the bundle id needs a Swift helper plus codesigning plus
  notarization; that is real work and it waits until the tool proves it deserves it.
- **Delivery is not verified.** `osascript` exits 0 whether or not the banner
  displayed. If your notifications are off or a Focus is filtering them, agentview
  cannot currently tell.
- **`watch` runs in the foreground** and dies with your terminal. No launchd yet.
- **macOS only.**

Every one of these is in [TODOS.md](TODOS.md) with its real cost.

## Development

```bash
bun test        # 44 tests
```

Fourteen of them guard failures that *look like success*: a re-blocked session that
silently never notifies, a cold start reporting "30m" about a day-old block, a
recycled pid producing a phantom that escalates forever, a crash recovering into a
notification storm. Those run first in `tick.test.ts` and `state.test.ts` for a
reason — everything else fails loudly and you would notice.

## License

MIT
