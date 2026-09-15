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
agentview doctor             what it can see, and everything it touches
```

Names take a prefix, so `agentview ack erp` is enough. It resolves against the live
session list and tells you if the prefix is ambiguous, because `erp-00` and `erp-0e`
are one character apart and one of them is the blocked one.

## The escalation ladder

```
  blocked
     |
   30m  ── "erp-00 waiting 30m"      Blocked since 10:21.
     |
    2h  ── "erp-00 waiting 2h"       Nothing since 08:51. Or: agentview ack erp-00
     |
    8h  ── "erp-00 waiting 8h"       Still blocked since 02:51.
     |
   24h  ── "erp-00 waiting 26h"      Still blocked since Mon 08:57.
     |
   48h  ── "erp-00 waiting 50h"      Last reminder. Still blocked since Sun 08:57.
     |
   silent — still listed by `agentview`, never notified again
```

**The ladder is finite on purpose.** agentview decides whether to nag you by reading
one field written by another program. We could not prove that field always clears
when you answer. Rather than trust it, the blast radius is bounded: five
notifications over two days, worst case, then silence. `agentview ack` is the manual
override, and it depends on nothing Claude Code does.

## What it reads and writes

- **Reads** `~/.claude/sessions/*.json` — session state only. That directory also
  contains `*.key` files at `0600`. agentview globs `*.json` and never lists, opens,
  or logs anything else. [There is a test that asserts this.](test/sessions.test.ts)
  It never reads your transcripts, prompts, or code.
- **Writes** `~/.agentview/` — `state.json`, `snoozes.json`, `agentview.log`. Nothing else.
- **Sends** nothing. No network calls, no telemetry, no update check.
  Verify: `grep -rn 'fetch\|http' src/`

`agentview doctor` prints all of the above, every time.

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
