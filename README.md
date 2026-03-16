# opencode-focus-notifications

macOS desktop notifications and terminal tab icons for [OpenCode](https://opencode.ai), with focus-aware suppression.

Get notified when OpenCode finishes responding, asks a question, requests permission, or errors out — but only when you're not already looking at it.

## Features

- **Desktop notifications** via macOS `osascript` with sound
- **Tab icons** — emoji prepended to your terminal tab title (e.g. `✅ my-session`)
- **Focus-aware suppression** — skip desktop notifications when you're already looking at the terminal
  - `"tab"` mode: suppress only when the specific session tab is focused
  - `"app"` mode: suppress when any terminal emulator is the frontmost app
  - `"none"`: always notify
- **4 event types**: response ready (✅), permission needed (🔐), question asked (❓), error (❌)
- **Configurable delay** before desktop notifications fire (default 5s)
- Icons appear immediately, desktop notification follows after the delay

## Requirements

- macOS (uses `osascript` for notifications and focus detection)
- [OpenCode](https://opencode.ai) v0.1+
- For `"tab"` focus mode: grant accessibility permissions to your terminal in System Settings > Privacy & Security > Accessibility

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gasparev/opencode-focus-notifications/main/install.sh | bash
```

This downloads `index.js` to `~/.config/opencode/plugins/notification.js`. Restart OpenCode to activate.

To update, run the same command again.

## Configuration

Create `oc-notification.json` in any of these locations (first found wins):

1. `~/.config/opencode/oc-notification.json` (global)
2. `<project>/oc-notification.json` (per-project)
3. `<project>/.opencode/oc-notification.json` (per-project, hidden)

```json
{
  "desktop": true,
  "tabIcon": true,
  "delay": 5,
  "focusMode": "tab"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `desktop` | `boolean` | `true` | Enable macOS desktop notifications |
| `tabIcon` | `boolean` | `true` | Enable emoji tab title icons |
| `delay` | `number` | `5` | Seconds to wait before firing desktop notification |
| `focusMode` | `string` | `"tab"` | `"none"` / `"app"` / `"tab"` — see below |

### Focus modes

| Mode | Behavior |
|------|----------|
| `"none"` | Always send desktop notifications |
| `"app"` | Suppress if any terminal emulator is the frontmost app |
| `"tab"` | Suppress only if this specific session's tab is focused |

Supported terminals for focus detection: Ghostty, iTerm2, Terminal.app, Alacritty, Kitty, WezTerm, Warp, Hyper, Tabby, Rio.

## How it works

The plugin subscribes to OpenCode events via the [plugin API](https://opencode.ai/docs/plugins):

- `session.idle` — assistant finished responding → ✅
- `session.error` — session errored (ignores aborts) → ❌
- `permission.asked` — tool needs approval → 🔐
- `question.asked` — agent has a question → ❓

**Tab icons** are set immediately via OSC 2 escape sequences written to the session's tty device. The plugin finds the correct `/dev/ttysXXX` by matching the OpenCode client process to the session ID via `ps`.

**Desktop notifications** fire after a configurable delay. At delivery time, the plugin checks focus state and suppresses the notification if you're already looking at the terminal (based on `focusMode`).

Icons are cleared when you send a new message, reply to a permission/question, or interrupt the session.

## License

MIT
