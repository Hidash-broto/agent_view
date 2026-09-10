# TODOS — agentview

Deferred scope, collected by /autoplan across all review phases. Nothing here blocks
v0.1.0; everything here was considered and consciously deferred.

## Deferred from the CEO phase

- **E1 — Answer a blocked session from the notification.** `messagingSocketPath` is
  present in every `~/.claude/sessions/*.json`, which is the door from observing to
  acting. This is the 10x version and it breaks the "agentview observes, never writes"
  boundary that makes v0.1.0 safe to trust. Revisit only after the observe-only tool
  has earned trust in daily use. Effort: L.
- **E2 — Menu bar badge** showing the count of blocked sessions. Ambient, nothing to
  open. Directly serves the C1 finding. Effort: M. Strong v0.2 candidate.
- **E3 — `agentview watch --quiet`**, daemon with no UI at all. Mostly falls out of
  the M2 work. Effort: S.
- **E4 — Sparkline** of how long each session was blocked today. Delight, not value.
  Effort: S.

## Deferred from the DX phase

- **M1.5 — transcript title join.** `custom-title` > `ai-title` > `last-prompt`, with
  glob-based transcript lookup (never derive the slug — see the design doc). Deferred
  because `cwd` basename plus name resolves the ambiguity for now. Revisit if
  `acme/erp erp-00` still reads ambiguously after a week.
- **`agentview --json`** for piping into a statusline or tmux prompt. One flag, real
  surface area. Likely the second-most-used feature; deferred only because nothing
  consumes it yet.
- **Notification action buttons beyond Snooze** (Open, Answer). Needs the app bundle
  from N1 to exist first.

## Deferred from the Eng phase

- **Cross-machine sync.** Out of scope permanently for v0.1.0's threat model.
- **IPC between CLI and daemon.** The state file is the interface. Revisit only if
  `agentview status` needs live data the file cannot carry.
- **Retry/backoff for `ps` and `claude` spawns.** A failed tick is fine; the next one
  is 250-500ms away.

## Still OPEN and load-bearing (not deferred — must be answered)

- **M0.2** — does `status` leave `waiting` promptly once the user answers? If it
  sticks, every answered session keeps nagging, which is the F2 failure from the
  user's side and would be reported as "your tool lied to me." Ten minutes.
- **M0.3** — does a sleep/wake cycle reset `statusUpdatedAt`? If it does, the 26h case
  reports as minutes and the product's headline number is wrong. Ten minutes.
- **Escalation thresholds** (30m/2h/8h/daily) are a guess. The right values come from
  a week of real use, which is why `config.toml` ships at v0.1.0.
