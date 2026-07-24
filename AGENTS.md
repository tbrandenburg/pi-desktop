# Agent Guidelines

For more details check docs/INITIAL.md

## Architecture rules (do not break)

1. Do not change the architecture: Electron + React + Vite + pi-ai (+ optional pi-agent-core).
2. Do not introduce Tauri, Rust, Next.js, or a separate server process.
3. Keep all Pi imports (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) inside `src/main/llm`.
4. The React renderer must never import Node or Pi APIs directly. It talks only through
   the typed preload bridge (`src/preload`).
5. Never place API keys in renderer state after saving. Settings round-trip through the
   main process only.
6. Target for tonight: Linux only (AppImage). Windows packaging is out of scope for now.
7. Do not begin `pi-agent-core` / tool integration until the direct `pi-ai` streaming chat
   works end-to-end in dev mode.
8. Keep STATUS.md updated with completed milestones and blockers.
9. Test the production package, not only dev mode, before declaring packaging done.

## Lessons learned (end-to-end UI review)

1. **Session browsing/recovery was a UI placeholder, not a real feature.**
   The sidebar only ever showed "Current conversation" text; there was no
   persistence, no way to switch between past conversations, and no
   per-session model. This is now backed by a `SessionStore`
   (`src/main/storage/session-store.ts`, same thin `electron-store` wrapper
   pattern as `SettingsStore`) plus 4 IPC channels
   (`sessions:list|get|save|delete`). Persist on `completed`/`error`/stop —
   never on every keystroke — to avoid needless disk writes.
2. **Renderer state needs a `conversationId`, not just message history.**
   Adding multi-session support only required one new field on the Zustand
   store (`conversationId`) plus `loadConversation`/`persistSession`
   actions; no new store, no routing library, no extra abstraction. Prefer
   growing the existing store over introducing a new one.
3. **Simplest way to UI-test an Electron app without a real Electron
   automation tool: run the Vite dev server in a plain browser and inject a
   tiny in-memory fake of the preload bridge** (`src/renderer/lib/fake-desktop-api.ts`),
   activated only when `window.desktopApi` is `undefined`. The real
   Electron preload always injects the real bridge before renderer scripts
   run, so this fake never activates in the packaged app — verified by
   screenshotting the production AppImage and confirming it shows the real
   `GPT-4o mini` model (from the real IPC handler) with an empty session
   list, not the fake's `Fake Mini` models. This let session
   browsing/recovery, model selection, and multi-turn chat all be exercised
   with standard Playwright browser automation instead of pixel-clicking an
   opaque Electron window.
4. **Recovery must restore both messages and the model used for that
   session.** Storing only message history is not enough for a believable
   "resume where I left off" experience — switching sessions has to also
   restore `selectedModel`, otherwise a resumed conversation silently
   continues with the wrong model.
5. **Persistence unit tests must hit real `electron-store` on a throwaway
   disk directory** (not a full in-memory mock) to prove data genuinely
   survives an app restart — see `session-store.test.ts`, following the
   existing pattern in `settings-store.test.ts`. A pure in-memory mock would
   pass even if the on-disk serialization were broken.
6. **electron-builder AppImages launch fine under Xvfb/X11 with
   `--no-sandbox --disable-gpu`**; without `--disable-gpu` the GPU process
   can crash-loop on headless/software-rendered X11 displays. Always launch
   detached (`setsid nohup ... &disown`) so the process survives the calling
   shell command's timeout.
7. **Fully-wired backend plumbing with no UI entry point is a bug, not a
   feature to leave alone.** `sessions:delete` had a real `SessionStore`
   method, IPC handler, and preload binding, but the Sidebar never called
   it — so there was no way to remove old sessions in normal usage. Session
   browsing without deletion breaks a real-world usage pattern (any user who
   runs the app for a while accumulates clutter with no way to clean it up).
   Fixed by wiring the already-existing `deleteSession` through the store
   into a hover-revealed `X` button per session row — reusing the existing
   IPC channel and Zustand store pattern rather than inventing anything new.
   Verified with Playwright: deleting the active session clears the message
   pane back to the empty state; deleting an inactive one just removes it
   from the list.
8. **Before running `npm run dev:renderer`, check if port 5173 is already
   bound** (`ss -ltnp | grep 5173`) — it may belong to an unrelated project's
   own Vite server, not a stale instance of this one. Killing "the process
   on port 5173" blindly can take down someone else's dev server; inspect
   the PID's command line first to confirm it actually belongs to this repo.
 9. **The `fake-desktop-api.ts` browser harness is sufficient to validate the
    three mandatory user journeys end-to-end** (session browsing + recovery,
    model selection, multi-turn chat) purely through the Vite dev server —
    no Electron automation needed for UI-level regression testing. Re-run
    this whenever the Sidebar, ChatTimeline, or chat-store change.
10. **Full re-run of the three mandatory journeys (2026-07-24) found zero
    regressions** — no fix was needed. Ran two conversations (fake-mini,
    fake-pro), switched models mid-flow via "New chat" (confirmed the
    selected model persists into a fresh conversation rather than resetting
    to a default), then jumped back to the older fake-mini session and
    confirmed both prior turns and the original model were restored exactly.
    Also re-verified active-session deletion clears the pane to the empty
    state. This is evidence that "no changes needed" is a valid, honest
    outcome of an end-to-end UI review — do not invent busywork fixes just
    to have something to report. The only console noise was a harmless
    `favicon.ico` 404, which is not a real error and not worth suppressing.

## How to test the compiled/packaged app (not just `npm test` / dev mode)

`npm test` and dev mode (`npm run dev`) both run through Vite/Node module
resolution directly from `.ts` source or a live dev server. Neither one
exercises `tsc`'s actual CommonJS compilation output, nor Electron's real
packaged file layout (`asar`, `resources/app`, native module unpacking).
**A change can pass every unit test and work perfectly in `npm run dev` and
still crash 100% of the time in the shipped AppImage.** Always validate the
real artifact before declaring a fix or milestone done:

1. Build and package for real: `make dist-linux` (or
   `npm run build && npx electron-builder --linux AppImage`). This produces
   `release/Pi Desktop Demo-<version>-linux-x86_64.AppImage` and, for faster
   iteration, `release/linux-unpacked/pi-desktop` (same app, no AppImage
   squashfs mount — use this first when only re-testing main-process logic).
2. Launch it **detached**, with a **remote debugging port**, and — critically
   — with an **explicit, unique `--user-data-dir`** so repeated launches
   never collide with a previous instance's single-instance lock (Electron
   silently forwards a second launch to the first running instance instead
   of erroring, which will make you debug the wrong process):
   ```bash
   setsid nohup env DISPLAY=:0.0 \
     "release/Pi Desktop Demo-0.1.0-linux-x86_64.AppImage" \
     --no-sandbox --remote-debugging-port=9222 \
     --user-data-dir=/tmp/opencode/pi-userdata-<unique> \
     > /tmp/opencode/run.log 2>&1 < /dev/null &
   disown
   ```
3. **Before every launch**, confirm no previous instance is still alive
   (`pgrep -af "Pi Desktop Demo\|linux-unpacked/pi-desktop"`) and kill it
   first. Overlapping instances on the same debug port make every
   subsequent CDP command silently talk to the wrong (stale) process, and
   overlapping `electron-builder` invocations racing on `release/` produce
   confusing, unrelated-looking build errors (`ENOENT: ... rename`,
   `unlinkat ...: directory not empty`) that have nothing to do with your
   code change.
4. Drive the real running app via the Chrome DevTools Protocol instead of
   OS-level clicks/keystrokes (see the next section for why): fetch
   `http://localhost:<port>/json` to get the page's `webSocketDebuggerUrl`,
   then use the `ws` package (already a transitive dependency; import via
   plain `node -e`/inline script — no need to add it to `package.json`) to
   send `Runtime.enable` and `Runtime.evaluate` commands that click buttons,
   set the composer's value via its native `<textarea>` value setter +
   `input` event, and dispatch a real `Enter` `keydown`. This exercises the
   full real IPC path (preload → main → `ChatService` → real provider HTTP
   call) with zero mocks.
5. Give slow free-tier model providers real time to respond (15–45s) before
   concluding a request is stuck; check for `429`/rate-limit text in the
   page body separately from a genuine hang.
6. Only trust "it works" once you've seen an actual assistant reply appear
   in `document.body.innerText` from a **fresh** conversation with **zero**
   manually-entered settings — that's the actual first-launch demo path.

## Never drive the desktop with OS-level input injection

During this project, using `xdotool`-style OS input synthesis (X11
`fake_input` via a small Python/Xlib script, since `xdotool` wasn't
installed) to click/type into the running AppImage sent keystrokes into the
**wrong window** (an unrelated terminal tab) because window focus was not
what it was assumed to be. This risked disrupting or corrupting completely
unrelated processes running on the same shared desktop session — including
accidentally killing a stray `vite` dev server that turned out to belong to
a different, unrelated project (`made/packages/frontend`), which could not
be un-killed afterward.

- **Never use OS-level input injection (`xdotool`, raw X11 `fake_input`,
  `ydotool`, etc.) to test this app**, or any app, when other windows may be
  present on the same display. There is no reliable way to guarantee focus
  lands on the intended window from a non-interactive script.
- **Always drive the app via Chrome DevTools Protocol** instead (see above):
  it targets a specific page/process by its debug port and page ID, so
  input can never leak into an unrelated window.
- If you must interact with the real OS desktop for verification (e.g. a
  final screenshot), only ever use **read-only** inspection (`import -window
  root` for screenshots, listing windows) — never synthesize clicks or
  keystrokes at the OS level.
- If a stray process is discovered mid-investigation (e.g. via `pgrep`) and
  its origin isn't 100% certain, do not kill it speculatively. Check its
  `cwd` (`readlink -f /proc/<pid>/cwd`) and full command line first, and if
  there's any doubt it might belong to something the user is actively
  relying on, leave it alone and ask instead of guessing.

## Diagnosing bugs that only reproduce in the packaged app

Two real, non-obvious bugs were found this way during this project — both
fully invisible to `npm test`, `npm run check`, and even `npm run dev`:

1. **`tsc`'s CommonJS output silently rewrites `await import(x)` into
   `Promise.resolve().then(() => require(x))`.** If `x` refers to an
   ESM-only package (like `@earendil-works/pi-ai`), this throws
   `ERR_PACKAGE_PATH_NOT_EXPORTED` or `"require() of ES Module ... not
   supported"` **only once compiled and run**, never when running plain
   `.ts` via `tsx`/`vitest` (which use real ESM-aware module resolution).
   Confirm this by grepping the *compiled* output
   (`dist-main/main/**/*.js` or `release/linux-unpacked/resources/app*/
   dist-main/**/*.js`) for the specifier in question — if you see
   `require(...)` where you wrote `import(...)`, this is the cause. Fix by
   hiding the call from tsc's static analysis:
   `new Function("specifier", "return import(specifier);")` — this survives
   compilation as a literal string, so V8 performs a genuine dynamic import
   at runtime. Because this also hides the call from Vitest's `vi.mock`
   module interception, make the loader an **injectable constructor
   dependency** instead, and have tests pass a fake implementation directly
   rather than mocking the module path.
2. **Electron's `app.isPackaged`/asar-aware module patches only apply to the
   real packaged app** — a plain `node -e "import(...)"` test, or even
   `ELECTRON_RUN_AS_NODE=1 electron -e "..."`, will NOT reproduce
   Electron-main-process-specific resolution quirks. Always reproduce the
   failure by launching the actual app (see the section above) and reading
   the exact error text/stack from its own stdout log — add a temporary
   `console.error(error)` in the relevant `catch` block if the error surfaced
   to the UI is too terse, rebuild `dist-main` only (`npm run build:main`,
   much faster than a full `electron-builder` package), and re-launch to see
   the full stack trace. Remove the temporary logging once diagnosed.
3. When a fix requires ruling out multiple candidate causes (e.g. "is this
   an `asar` limitation, or a module-resolution bug?"), verify each
   hypothesis by toggling exactly one variable at a time and re-testing
   against the real packaged app — don't stop at the first plausible-looking
   theory. In this project, an initial "Node's ESM loader can't read from
   `asar`" conclusion turned out to be a red herring; the real cause (tsc's
   CJS downlevel of `import()`) was only found by testing `asar: true` and
   `asar: false` independently and noticing the same class of error
   persisted either way once the actual root cause was isolated.

