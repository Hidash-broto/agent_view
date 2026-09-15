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

- ~~**M1.5 — transcript title join.**~~ **SHIPPED**, and as something better than a
  title: `src/context.ts` pulls the last prompt, last reply, branch and PR from the
  transcript tail. A real user hit exactly the predicted problem ("I can't tell which
  session this is from the name") within a day of the tool existing.
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

## Deferred at the /autoplan final gate (2026-09-14)

Cut from v0.1.0 to keep the first version to one night. Every item here was *accepted*
by a review phase, then deferred on cost once the total was honestly re-costed at 5-8
days. None of them are rejected; they are sequenced behind knowing whether the tool
gets used.

- **N1 / N4 / N6 — the signed `agentview.app` bundle.** Owning the bundle id (so the
  notification stops saying "Script Editor"), requesting Time Sensitive so it survives
  Focus, a Snooze action button, and click-to-focus-the-tty. Originally costed at
  "~40KB Info.plist + helper"; actually needs a compiled ObjC/Swift helper linking
  UserNotifications.framework, plus codesign and notarization. **This one item is most
  of the 5-8 day estimate.** Do it when you know you want the tool.
- **N2 — `doctor` delivery round-trip.** And note the originally-accepted version was
  wrong: the `presented` column is not a delivery flag (verified: 64 rows at 0, 8 at
  1). Check record existence with a recent `delivered_date` instead. Also needs Full
  Disk Access, which a launchd-started binary will not have — detect and explain that
  case rather than reporting a delivery failure.
- **N5 — coalescing.** One notification per tick when 2+ sessions cross a rung
  together. Matters at 7+ sessions; you have 7. Promote early if M4 shows bursts.
- **D2 — launchd lifecycle** (`start` / `stop` / `status` / `uninstall` + plist) and
  **Q3 brew services**. Until this exists, `agentview watch` dies when you close the
  terminal — which is the same class of bug as v1's "dashboard you must remember to
  open." Accept it only because you are dogfooding in the foreground.
- **D5 / Q1 — `config.toml` and `quiet_hours`.** quiet_hours is the best single idea
  in the DX review (let the ladder count overnight, deliver one honest "waited 9h
  overnight" at 07:30 instead of a 3am banner into Focus). It needs local-zone date
  math with DST handling, and **Asia/Kolkata has no DST so you cannot reproduce the
  bugs locally** — needs `TZ=America/New_York` fixtures at 2026-03-08 and 2026-11-01.
- **The idle ladder.** `acme-api-47` idle 190m and `erp-0e` idle 187m
  are arguably neglect too. One enum value, but it changes what the product claims.
- **M1.5 — transcript title join.** `cwd` basename plus name is enough for now.
- **`agentview --json`** for statusline/tmux piping.
- **Brew tap and release automation.** Gated on the week of use, per the CEO phase.

## Raised by use, not by review (2026-09-15)

- **A `--no-transcripts` flag.** Reading transcript tails is what makes `show` and the
  context lines work, and it is also the only part of agentview that touches message
  content. Someone will want it off. One flag, one branch in `contextFor`.
- **Context for non-blocked sessions.** `agentview show` works on any session, but the
  plain list only shows context for blocked ones. Cheap to extend, unclear if wanted.
- **Truncation is naive.** `oneLine` clips at a character count, so a long first
  sentence can crowd out the informative part of a prompt. Clipping at a sentence
  boundary would read better.
