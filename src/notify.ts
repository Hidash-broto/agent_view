/** macOS notification via osascript.
 *
 *  KNOWN AND ACCEPTED FOR v0.1.0: these arrive attributed to "Script Editor"
 *  (com.apple.scripteditor2), because `display notification` posts under the
 *  scripting host rather than under us. Owning the bundle id needs a compiled
 *  Swift helper plus codesign plus notarization — deferred to TODOS until the
 *  tool has proved it is worth that. It is ugly; it works; it is yours only.
 *
 *  ALSO KNOWN: osascript exits 0 whether or not the notification was actually
 *  displayed, so a `true` return here means "posted", never "seen". Do not build
 *  anything on the assumption that it means delivered. */

import type { Notification } from "./types.ts";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface Notifier {
  (n: Notification): Promise<boolean>;
}

export const osascriptNotifier: Notifier = async (n) => {
  const script =
    `display notification "${esc(n.body)}" ` +
    `with title "${esc(n.title)}" subtitle "${esc(n.subtitle)}"`;
  try {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
    const code = await p.exited; // always await: otherwise the fd and zombie leak
    return code === 0;
  } catch {
    return false;
  }
};

/** Used by tests and by `--dry-run`. */
export function collectingNotifier(sink: Notification[]): Notifier {
  return async (n) => {
    sink.push(n);
    return true;
  };
}
