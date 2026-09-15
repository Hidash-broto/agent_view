/**
 * The escalation ladder. Pure: no I/O, no Date.now(), no side effects.
 *
 * Every due-time is anchored to `blockedSince`, never to "when we last notified".
 * That single choice is what makes the ladder identical before and after a daemon
 * restart, correct at cold start on a session that was already blocked for a day,
 * and correct after the laptop sleeps through three rungs at once.
 *
 * The ladder is FINITE on purpose. See PLAN.md — correctness must not depend on
 * Claude Code's `status` field eventually leaving "waiting", because we could not
 * verify that it always does. Five rungs bounds the worst case to five wrong
 * notifications over two days instead of an unbounded stream.
 */

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

/** Rung 0 is deliberately 30s rather than 0: if you answer straight away, which is
 *  the common case while you are actually at the keyboard, you get nothing. Miss it
 *  by half a minute and you are told. Override any of this in config.json. */
export const LADDER: readonly number[] = [
  30 * SEC,
  30 * MIN,
  2 * HOUR,
  8 * HOUR,
  24 * HOUR,
];

export const MAX_RUNG = LADDER.length - 1;

/** Absolute epoch at which `rung` becomes due. Independent of `now` by construction. */
export function dueAt(blockedSince: number, rung: number, ladder = LADDER): number {
  if (rung <= 0) return blockedSince + ladder[0]!;
  const i = Math.min(rung, ladder.length - 1);
  return blockedSince + ladder[i]!;
}

/** Highest rung due at `now`, or -1 if none. */
export function highestDueRung(blockedSince: number, now: number, ladder = LADDER): number {
  let due = -1;
  for (let i = 0; i < ladder.length; i++) {
    if (now >= blockedSince + ladder[i]!) due = i;
    else break;
  }
  return due;
}

/** Once the top rung is delivered the session goes silent: list-only, never notified again. */
export function isExhausted(rung: number, ladder = LADDER): boolean {
  return rung >= ladder.length - 1;
}

/** Wall-clock durations can go backwards (NTP). Never let that reach the rest of the program. */
export function elapsed(blockedSince: number, now: number): number {
  return Math.max(0, now - blockedSince);
}
