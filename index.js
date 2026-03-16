// macOS desktop notification plugin for OpenCode
// Fires osascript notifications + sets tab icon emoji when the AI
// finishes responding, asks a question, or requests permission.
//
// Configuration: place oc-notification.json in ~/.config/opencode/ or project root.
// {
//   "desktop": true,    — enable/disable macOS desktop notifications
//   "tabIcon": true,    — enable/disable emoji tab icons
//   "delay": 5,         — seconds to wait before desktop notification
//   "focusMode": "tab"  — "none" = always notify, "app" = suppress if any
//                          terminal focused, "tab" = suppress only if THIS tab focused
// }

import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from "fs";
import { join } from "path";

// Load config from oc-notification.json (global config dir, project root, or .opencode/)
export function loadConfig(directory) {
  const defaults = { desktop: true, tabIcon: true, delay: 5, focusMode: "tab" };
  const candidates = [
    join(process.env.HOME ?? "", ".config", "opencode", "oc-notification.json"),
    join(directory ?? ".", "oc-notification.json"),
    join(directory ?? ".", ".opencode", "oc-notification.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        return { ...defaults, ...raw };
      }
    } catch {
      // malformed JSON — use defaults
    }
  }
  return defaults;
}

// Emoji icons per event type
export const ICONS = {
  "session.idle": "\u2705",
  "session.error": "\u274c",
  "permission.asked": "\ud83d\udd10",
  "question.asked": "\u2753",
};

function notify(title, message) {
  const escaped = (s) => String(s).replace(/[\\"]/g, "\\$&");
  const script = `display notification "${escaped(message)}" with title "${escaped(title)}" sound name "Ping"`;
  Bun.spawn(["osascript", "-e", script], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

// Known terminal emulator process names (macOS System Events).
// Checked case-insensitively against the frontmost app name.
const TERMINAL_APPS = new Set([
  "ghostty", "iterm2", "terminal", "alacritty", "kitty",
  "wezterm", "warp", "hyper", "tabby", "rio",
]);

// Returns the frontmost macOS app name (lowercase), or null if unknown.
function getFrontmostApp() {
  try {
    const proc = Bun.spawnSync(
      ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
      { stdout: "pipe", stderr: "ignore" },
    );
    return proc.stdout.toString().trim().toLowerCase();
  } catch {
    return null;
  }
}

// Returns the title of the frontmost terminal window/tab, or null.
// Requires macOS accessibility permissions.
function getFrontmostTerminalTitle() {
  const app = getFrontmostApp();
  if (!app || !TERMINAL_APPS.has(app)) return null;
  try {
    const proc = Bun.spawnSync(
      ["osascript", "-e", `tell application "System Events" to tell process "${app}" to get title of front window`],
      { stdout: "pipe", stderr: "ignore" },
    );
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

// Returns true if the given session's tab is the currently focused terminal tab.
// Compares the frontmost terminal window title against the session title.
function isSessionTabFocused(sessionTitle) {
  const windowTitle = getFrontmostTerminalTitle();
  if (!windowTitle) return false;
  // Window title may contain the session title (possibly with emoji prefix)
  return windowTitle.toLowerCase().includes(sessionTitle.toLowerCase());
}

// Find the tty device for an OpenCode client running a given session ID.
// Returns e.g. "/dev/ttys003" or null if not found.
// Caches results since session->tty mapping doesn't change.
const ttyCache = new Map();
function findTtyForSession(sessionId) {
  if (ttyCache.has(sessionId)) return ttyCache.get(sessionId);
  try {
    const proc = Bun.spawnSync(["ps", "-eo", "tty,args"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = proc.stdout.toString();
    for (const line of output.split("\n")) {
      if (line.includes(sessionId) && line.includes("opencode")) {
        const tty = line.trim().split(/\s+/)[0];
        if (tty && tty !== "??" && tty !== "TTY") {
          const path = `/dev/${tty}`;
          ttyCache.set(sessionId, path);
          return path;
        }
      }
    }
  } catch {
    // ps not available or failed
  }
  ttyCache.set(sessionId, null);
  return null;
}

// Write an OSC 2 escape sequence to the session's tty to set the tab title.
function setTerminalTitle(sessionId, title) {
  const ttyPath = findTtyForSession(sessionId);
  if (!ttyPath) return;
  try {
    const fd = openSync(ttyPath, "w");
    writeFileSync(fd, `\x1b]2;${title}\x07`);
    closeSync(fd);
  } catch {
    // tty may not be writable
  }
}

// --- Core event handler logic (extracted for testability) ---

// Creates the event handler and scheduler with injectable dependencies.
// `deps` allows tests to replace OS-bound functions with mocks.
export function createEventHandler(config, deps) {
  const {
    notifyFn = notify,
    setTabIconFn,
    clearTabIconFn,
    getSessionTitleFn,
    isSessionTabFocusedFn = isSessionTabFocused,
    getFrontmostAppFn = getFrontmostApp,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  const DELAY_MS = (config.delay ?? 5) * 1000;
  const focusMode = config.focusMode ?? "tab";

  const pending = new Map(); // sessionId -> timeoutId
  const assistantSeen = new Set(); // sessions where assistant responded
  const interrupted = new Set(); // sessions that were interrupted
  const userMsgIds = new Map(); // sessionId -> last user messageID
  const iconActive = new Set(); // sessions that currently have a tab icon

  async function setTabIcon(sid, icon) {
    if (!config.tabIcon) return;
    if (setTabIconFn) {
      await setTabIconFn(sid, icon);
    } else {
      const title = await getSessionTitleFn(sid);
      setTerminalTitle(sid, `${icon} ${title}`);
    }
    iconActive.add(sid);
  }

  async function clearTabIcon(sid) {
    if (!iconActive.has(sid)) return;
    if (clearTabIconFn) {
      await clearTabIconFn(sid);
    } else {
      const title = await getSessionTitleFn(sid);
      setTerminalTitle(sid, title);
    }
    iconActive.delete(sid);
  }

  function schedule(sessionId, eventType, notifyTitle, message) {
    cancelTimer(sessionId);

    // Set tab icon immediately (no delay), regardless of focus
    const icon = ICONS[eventType];
    if (icon) setTabIcon(sessionId, icon);

    if (config.desktop) {
      const id = setTimeoutFn(async () => {
        // Focus mode: suppress desktop notification based on focus state
        if (focusMode === "app") {
          const app = getFrontmostAppFn();
          if (app && TERMINAL_APPS.has(app)) {
            pending.delete(sessionId);
            return;
          }
        } else if (focusMode === "tab") {
          const title = await getSessionTitleFn(sessionId);
          if (isSessionTabFocusedFn(title)) {
            pending.delete(sessionId);
            return;
          }
        }
        notifyFn(notifyTitle, message);
        pending.delete(sessionId);
      }, DELAY_MS);
      pending.set(sessionId, id);
    }
  }

  function cancelTimer(sessionId) {
    const id = pending.get(sessionId);
    if (id) {
      clearTimeoutFn(id);
      pending.delete(sessionId);
    }
  }

  async function handleEvent({ event }) {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info ?? event.properties;
        const role = info.role;
        const sid = info.sessionID;
        const msgId = info.id;
        if (!sid) break;

        if (role === "assistant") {
          assistantSeen.add(sid);
          interrupted.delete(sid);
        } else if (role === "user") {
          // Only react to NEW user messages (new messageID), not re-updates
          const prev = userMsgIds.get(sid);
          if (msgId && msgId !== prev) {
            userMsgIds.set(sid, msgId);
            assistantSeen.delete(sid);
            interrupted.delete(sid);
            cancelTimer(sid);
            clearTabIcon(sid);
          }
        }
        break;
      }

      case "session.idle": {
        const sid = event.properties.sessionID;
        if (!sid) break;
        if (interrupted.has(sid)) {
          interrupted.delete(sid);
          assistantSeen.delete(sid);
          break;
        }
        if (!assistantSeen.has(sid)) break;

        assistantSeen.delete(sid);
        const title = await getSessionTitleFn(sid);
        schedule(sid, "session.idle", "Response Ready", title);
        break;
      }

      case "session.error": {
        const sid = event.properties.sessionID;
        if (!sid) break;
        if (event.properties.error?.name === "MessageAbortedError") {
          interrupted.add(sid);
          cancelTimer(sid);
          clearTabIcon(sid);
          break;
        }
        schedule(sid, "session.error", "Session Error", "An error occurred");
        break;
      }

      case "permission.asked": {
        const sid = event.properties.sessionID;
        schedule(sid, "permission.asked", "Permission Needed", "OpenCode needs your approval");
        break;
      }

      case "question.asked": {
        const sid = event.properties.sessionID;
        schedule(sid, "question.asked", "Question", "OpenCode has a question for you");
        break;
      }

      case "permission.replied":
      case "question.replied": {
        const sid = event.properties.sessionID;
        cancelTimer(sid);
        clearTabIcon(sid);
        break;
      }

      case "command.executed": {
        if (event.properties.name === "session.interrupt") {
          const sid = event.properties.sessionID;
          interrupted.add(sid);
          cancelTimer(sid);
          clearTabIcon(sid);
        }
        break;
      }

      // Don't cancel on session.status busy — it fires during normal response flow
    }
  }

  function destroy() {
    for (const id of pending.values()) clearTimeoutFn(id);
    pending.clear();
    assistantSeen.clear();
    interrupted.clear();
    userMsgIds.clear();
    iconActive.clear();
  }

  // Expose internal state for testing
  return {
    handleEvent,
    destroy,
    schedule,
    cancelTimer,
    // State accessors for assertions
    _state: { pending, assistantSeen, interrupted, userMsgIds, iconActive },
  };
}

// --- Main plugin export (wires real dependencies) ---

export const NotificationPlugin = async ({ client, directory }) => {
  const config = loadConfig(directory);

  async function getSessionTitle(sid) {
    const session = await client.session
      .get({ path: { id: sid } })
      .catch(() => null);
    return session?.data?.title ?? "OpenCode";
  }

  const handler = createEventHandler(config, { getSessionTitleFn: getSessionTitle });

  return {
    event: handler.handleEvent,
    destroy: handler.destroy,
  };
};
