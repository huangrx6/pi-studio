# Desktop control

Pi Studio’s desktop tools observe and operate application windows on macOS and Windows. The service checks the user’s desktop-control settings and the permissions available on the host. Implementation details live in `electron/main/services/desktop-control/` and `electron/main/capabilities/desktop-control/`.

Related: [capabilities](capabilities.md), [browser](browser.md).

## Goals

- Let the agent list running apps, list windows of **allowed** apps, read a bounded accessibility tree, and capture a selected window and its visible same-app panels.
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
| Screen Recording | Window capture through ScreenCaptureKit or the single-window `screencapture -l` fallback |
| Accessibility | Window enumeration, AX snapshot, click/type/scroll/drag/hotkey |

Write actions also require Accessibility (CGEvent / System Events still depend on a trusted process).

`desktop_apps` / installed-app picker can list running apps via NSWorkspace without Accessibility, so users can discover what to allow first. Window listing and snapshots still require Accessibility.

Settings UI shows status and opens the matching macOS Privacy pane. Permission state is separate from the app allow list.

On macOS, WindowServer can present search results in a separate same-process window above the main window. The capture helper composites eligible visible panels into the main image. A click taken from that image is bound to the observed panel ID and frame and rechecked before dispatch. A visible panel can be clicked on its current display. Some apps dismiss panels when they lose focus, so a background search can show the query without exposing results.

For autocomplete, set `searchField: true` on `desktop_type` or on a `desktop_act` batch that focuses the field and types the query. Leave `submit` unset. The same tool result includes the window image. The helper watches for a popup for up to 1.2 seconds and takes a final window image for suggestions drawn inline. On macOS it also reads visible item titles when the focused expanded control exposes them through Accessibility. On Windows it captures visible popups owned by the selected window as separate images. Each popup click rechecks the owner and observed frame.

A wait-only batch with a window ID leaves the window on its current display. For an app with a known rendering delay, an explicit final wait or `settleMs` on `desktop_act` sets the capture time. If a user changes focus and the app closes its suggestions, inspect the returned image or use `desktop_snapshot` on the same window before selecting anything.

On macOS 14 or later, run `node scripts/qa/qa-desktop-search-dropdown.cjs` with the development helper already authorized for Accessibility and Screen Recording to check this behavior. The fixture delays both a separate panel and an inline suggestion, dismisses them on focus loss, and saves the captured images under `.qa/`.

## Agent tools

| Tool | Behavior |
| --- | --- |
| `desktop_status` | Switch, permissions, setup todos, and recent observation metadata |
| `desktop_launch` | On macOS, open an application in the background or reuse an existing window. The user can bring it to the foreground with the preview button. |
| `desktop_act` | Apply ordered actions to the selected window, then return its image and any separately captured same-app panels. A single click on a popup in the main image binds its observed window ID and frame automatically. For a separate popup image, pass its `popupWindowId` and image-relative coordinates. Both forms keep the main `windowId` and recheck the popup before dispatch. |
| `desktop_apps` | Running apps with allow / need / block markers |
| `desktop_windows` | Windows for allowed apps; others only in `skipped` |
| `desktop_snapshot` | Bounded AX tree for one allowed app/window |
| `desktop_screenshot` | Capture the allowed window identified by `windowId` and its available same-app panels |
| `desktop_click` | Click inside one allowed window via snapshot ref/path or in-window x/y |
| `desktop_type` | Type plain text into one allowed window. A search-field edit also returns the observed suggestions and window image. |
| `desktop_scroll` | Scroll inside one allowed window via direction/amount or dx/dy |
| `desktop_drag` | Drag inside one allowed window from start ref/point to end ref/point |
| `desktop_hotkey` | Press a key/chord in one allowed window; blocks dangerous system shortcuts |

When an eligible app needs approval, an action such as `desktop_launch` can request access for the current conversation. Users can also approve apps in Settings. `desktop_status` reports supported actions and tools.

## Security notes

- Renderer only receives JSON-serializable settings/status payloads.
- Credentials never cross into this surface.
- Allow-list matching prefers **bundle id**. If both sides have bundle ids and they differ, name/path must not match.
- `desktop_screenshot` and `desktop_snapshot` (when `windowId` is set) verify the window id belongs to the allowed app before capture.
- Secure/password accessibility fields omit `value`. Screenshot payloads are soft-capped (scale down large retina captures).
- Observed text and images enter the current model/session context; Settings UI warns about this.
- Local activity log (`desktopControlActivity`) stores tool/app/window/time metadata only—never screenshots or AX values. Shown in Settings → 电脑操控 → 最近观察.
- Window list includes `minimized` / `visible`. On macOS the service can try a single-window capture for an offscreen window. Known minimization, a protected capture, or an unavailable frame produces a distinct result.
- `desktop_click` reuses allow policy + window ownership. Coordinates outside the window bounds are refused. Secure/password nodes are not clickable.
- `desktop_type` reuses the same policy. Optional `ref`/`elementPath` click-to-focus first; otherwise types into current focus after a secure-field probe. Empty / oversize / control-character text is refused. Activity detail records character count only—never the typed string.
- `desktop_scroll` reuses window ownership. Defaults to window center; optional ref/path/x/y set the scroll point. Direction+amount or signed dx/dy (line units, capped). Outside-window points are refused.
- `desktop_drag` requires in-window start and end (ref/path or coordinates). Secure start targets, zero-length, and oversized drags are refused. Activity logs endpoints only.
- On macOS, controls that expose `AXPress` or a writable text `AXValue` support background operation through a snapshot reference. The service checks the window, process and control identity before dispatch.
- The macOS Virtual Stage can route input to supported background windows. Physical actions require the original window to be in front and pause during Mission Control. The agent retains its window ID across these transitions.
- Each automatic preview and staged window follows its owning Durable run. The preview closes when the run ends. The last borrower restores a window still on the stage without activating its app. If the user has already moved the window elsewhere, cleanup preserves that placement. The helper disconnects its virtual display when its last borrower leaves.
- In messaging workflows the agent selects a readable result and compares the open conversation title with the requested recipient before sending. The tool compares the supplied title with the user’s request and accepts a displayed member-count suffix. The model reads the title and inspects the full composer, including image thumbnails and file attachments. Before editing or submitting, the tool requires a current-turn image for the same window and the model’s observation of an empty composer. A later step can submit a draft visibly containing only content that this run added after that check. Existing or unreadable drafts stop the operation. Multiline text and deliberate clipboard pastes require a separate observation before submission.
- `desktop_hotkey` checks the target window before posting. Supports single characters, named keys, and modifiers. Blocks ⌘Q, ⌘⌥Esc, ⌃⌘Q, ⌘Tab, ⌘Space. Activity logs the chord only.
- Observation runners are injectable for tests; unit tests must not require a real GUI session.

## Later phases

Optional polish (key repeat/hold, multi-window gestures, richer smoke tests) should reuse the same policy service, window-ownership checks, and activity log. Keep the `desktopControl` settings key shape stable. The current action surface is observe + click + type + scroll + drag + hotkey.
