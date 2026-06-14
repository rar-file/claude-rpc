// Pure helpers for the daemon's file-watch + mtime-poll fallback. Kept out of
// daemon.js so they're unit-testable without booting the daemon (daemon.js
// runs side effects — mkdir, logging, the IPC connect — at import time).
//
// The daemon reacts to on-disk changes (state.json, pause.json, config.json,
// aggregate.json) two ways at once: a directory watcher (instant) and this
// mtime poll (never misses). fs.watch is reliable on macOS/Linux via
// inotify/FSEvents, but on Windows it drops events when the writer commits via
// atomic rename — which state.js, pause.js, the scanner, and the settings GUI
// all do. So on Windows the poll is effectively the primary path and runs an
// order of magnitude faster; elsewhere it's a lazy backstop.

export const WATCH_POLL_MS = 30_000;
export const WATCH_POLL_WIN_MS = 3_000;

// How often the fallback poll runs. Fast on Windows (watcher unreliable),
// lazy on macOS/Linux (watcher reliable — this is just belt-and-suspenders).
export function pollIntervalMs(platform = process.platform) {
  return platform === 'win32' ? WATCH_POLL_WIN_MS : WATCH_POLL_MS;
}

// Per-target poll decision, given the last mtime we reacted to (`prev`) and
// the file's current mtime (`cur`, undefined when absent / stat failed):
//   'seed' — first observation: record the baseline, don't react (the file
//            merely already existed at startup).
//   'fire' — mtime advanced past what we last handled: the watcher missed an
//            event, react now.
//   'idle' — no change, file gone, or mtime went backwards (file replaced
//            with an older copy — atomic writers only ever move it forward).
// Both the watcher and the poll record into the same baseline, so a change
// one path already handled resolves to 'idle' for the other instead of a
// duplicate push.
export function pollDecision(prev, cur) {
  if (cur === undefined) return 'idle';
  if (prev === undefined) return 'seed';
  return cur > prev ? 'fire' : 'idle';
}
