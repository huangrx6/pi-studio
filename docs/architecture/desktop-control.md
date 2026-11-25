# Desktop control

Pi Studio’s desktop control follows a **Codex Computer Use–style** model: the agent observes (and can lightly act on) the user’s real Mac apps through explicit settings and OS permissions. Implementation details live in code under `electron/main/services/desktop-control/` and `electron/main/capabilities/desktop-control/`.

Related: [capabilities](capabilities.md), [browser](browser.md).

## Goals

- Let the agent list running apps, list windows of **allowed** apps, read a bounded accessibility tree, and capture a **single-window** screenshot.
- Let the agent **click** inside an allowed window using snapshot `ref`/`path` or in-window coordinates.
- Let the agent **type** plain text into an allowed window (optionally click-to-focus a snapshot node first). Typed content is never stored in the activity log.
- Let the agent **scroll** inside an allowed window (direction/amount or dx/dy; optional ref/path/x/y for the scroll point).
- Let the agent **drag** inside an allowed window from a start ref/point to an end ref/point.
- Let the agent send **hotkeys** to an allowed window (with dangerous system chords blocked).
- Keep a clear human control plane in **Settings → 电脑操控**.
- Default everything off. No silent full-screen capture.

## Non-goals (this phase)

- Multi-step write macros or cross-app automation beyond the allow list.
- Browser-extension management or Office add-ins (those belong to other surfaces).
- Observing Pi Studio itself, terminal apps, or system authorization UI.
- Full-screen screenshots when a window id is missing.

## Settings model

Persisted under Studio SQLite key `desktopControl` (not `~/.pi`):

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch for agent desktop tools |
| `allowAnyApp` | `false` | Observe any non-blocked frontmost app |
| `alwaysAllow` | `[]` | Explicit allow list: `{ id, name, bundleId, path }` |

Allow list entries are chosen from installed `.app` bundles. Manual path typing is not supported.

## Hard blocks (deny list wins)

Always refuse, even when `allowAnyApp` is on:

- Self: Pi Studio / current Electron identity
- Terminals: Terminal, iTerm, Warp, Alacritty, kitty, WezTerm, Ghostty, Hyper
- System auth / installer surfaces: SecurityAgent, loginwindow, CoreServicesUIAgent, Installer, softwareupdate, UserNotificationCenter
- Password / vault surfaces: Passwords, Keychain Access, 1Password, Bitwarden
- System Settings / System Preferences

Embedded terminals inside allowed editors (VS Code, Cursor, etc.) are **not** fully blocked in this phase; the hard block covers standalone terminal apps only.

## System permissions

| Permission | Used for |
| --- | --- |
| Screen Recording | Window screenshots via `screencapture -l <windowId>` |
| Accessibility | Window enumeration, AX snapshot, click/type/scroll/drag/hotkey |

Write actions also require Accessibility (CGEvent / System Events still depend on a trusted process).

`desktop_apps` / installed-app picker can list running apps via NSWorkspace without Accessibility, so users can discover what to allow first. Window listing and snapshots still require Accessibility.

Settings UI shows status and opens the matching macOS Privacy pane. Permission state is separate from the app allow list.

## Agent tools

| Tool | Behavior |
| --- | --- |
| `desktop_status` | Switch, permissions, setup todos, and recent observation metadata |
| `desktop_apps` | Running apps with allow / need / block markers |
| `desktop_windows` | Windows for allowed apps; others only in `skipped` |
| `desktop_snapshot` | Bounded AX tree for one allowed app/window |
| `desktop_screenshot` | PNG of one allowed window; **requires** `windowId` |
| `desktop_click` | Click inside one allowed window via snapshot ref/path or in-window x/y |
| `desktop_type` | Type plain text into one allowed window; optional ref/path focuses first |
| `desktop_scroll` | Scroll inside one allowed window via direction/amount or dx/dy |
| `desktop_drag` | Drag inside one allowed window from start ref/point to end ref/point |
| `desktop_hotkey` | Press a key/chord in one allowed window; blocks dangerous system shortcuts |

Unauthorized apps return a clear `desktop_needs_approval` error. This phase does **not** open a confirmation dialog mid-tool; the user adds the app in Settings. `desktop_status` also reports the supported `actions` / `tools` lists for agent setup checks.

## Security notes

- Renderer only receives JSON-serializable settings/status payloads.
- Credentials never cross into this surface.
- Allow-list matching prefers **bundle id**. If both sides have bundle ids and they differ, name/path must not match.
- `desktop_screenshot` and `desktop_snapshot` (when `windowId` is set) verify the window id belongs to the allowed app before capture.
- Secure/password accessibility fields omit `value`. Screenshot payloads are soft-capped (scale down large retina captures).
- Observed text and images enter the current model/session context; Settings UI warns about this.
- Local activity log (`desktopControlActivity`) stores tool/app/window/time metadata only—never screenshots or AX values. Shown in Settings → 电脑操控 → 最近观察.
- Window list includes `minimized` / `visible`. Screenshots refuse minimized or non-visible windows (`desktop_window_not_visible`).
- `desktop_click` reuses allow policy + window ownership. Coordinates outside the window bounds are refused. Secure/password nodes are not clickable.
- `desktop_type` reuses the same policy. Optional `ref`/`elementPath` click-to-focus first; otherwise types into current focus after a secure-field probe. Empty / oversize / control-character text is refused. Activity detail records character count only—never the typed string.
- `desktop_scroll` reuses window ownership. Defaults to window center; optional ref/path/x/y set the scroll point. Direction+amount or signed dx/dy (line units, capped). Outside-window points are refused.
- `desktop_drag` requires in-window start and end (ref/path or coordinates). Secure start targets, zero-length, and oversized drags are refused. Activity logs endpoints only.
- `desktop_hotkey` activates the owned window first. Supports single characters, named keys, and modifiers. Blocks ⌘Q, ⌘⌥Esc, ⌃⌘Q, ⌘Tab, ⌘Space. Activity logs the chord only.
- Observation runners are injectable for tests; unit tests must not require a real GUI session.

## Later phases

Optional polish (key repeat/hold, multi-window gestures, richer smoke tests) should reuse the same policy service, window-ownership checks, and activity log. Keep the `desktopControl` settings key shape stable. The current action surface is observe + click + type + scroll + drag + hotkey.
