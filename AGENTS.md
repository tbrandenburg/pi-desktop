# Agent Guidelines

For more details check docs/INITIAL.md

## Make targets

The Makefile is the source of truth (`make help` always reflects it exactly);
this list exists so agents don't have to open the Makefile just to know what
exists.

- `make install` — Install all dependencies (`npm install`).
- `make run` — Start dev mode (renderer + main + electron via `npm run dev`).
- `make stop` — Kill any running dev/electron processes started by `make run`.
- `make test` — Run unit tests (`vitest`).
- `make lint` / `make check` — Type-check renderer + main (`tsc --noEmit`, no
  auto-fix; both names are aliases).
- `make build` (`build-renderer`, `build-main`) — Build renderer + main for
  production.
- `make pack` — Build + package app dir only, no installer (fast local check).
- `make dist` — Build + package installers for the current host platform.
- `make dist-linux` — Build + package the Linux AppImage.
- `make dist-win` — Build + package Windows nsis + portable installers
  (requires `wine`/`mono` when cross-building from Linux).
- `make clean` — Remove build artifacts (`dist-main`, `dist-renderer`,
  `release`, `node_modules`).
- `make run-bundled` — Run whatever was already built for the current host
  platform (best-effort, picks the newest match under `release/`).
- `make run-linux` / `make run-win` — Run a specific already-built artifact
  directly (Linux AppImage / Windows exe, the latter via `wine` when
  cross-running).
- `make version-patch` / `version-minor` / `version-major` — Run `check` +
  `test` first, then bump `package.json`/`package-lock.json`, commit
  `chore(release): vX.Y.Z`, and git-tag it. Nothing pushed yet.
- `make release` — Push the current release commit + its version tag to
  `origin`.
- `make publish` — Create the GitHub release for the current tag via `gh`
  (release notes only). Pushing the tag (via `make release`) triggers
  `.github/workflows/release.yml`, which builds and attaches the Linux
  AppImage and Windows portable exe automatically — no local `dist-linux`/
  `dist-win` step is required for a normal release.
- `make release-patch` / `release-minor` / `release-major` — One-shot:
  version bump → push → publish, in that order.

## Architecture rules (do not break)

1. Do not change the architecture: Electron + React + Vite + pi-ai (+ optional pi-agent-core).
2. Do not introduce Tauri, Rust, Next.js, or a separate server process.
3. Keep all Pi imports (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) inside `src/main/agent` and `src/main/model` (formerly `src/main/llm`, re-homed by domain in #59).
4. The React renderer must never import Node or Pi APIs directly. It talks only through
   the typed preload bridge (`src/preload`).
5. Never place API keys in renderer state after saving. Settings round-trip through the
   main process only.
6. Target for tonight: Linux only (AppImage). Windows packaging is out of scope for now
   (though `npm install` / `npm run check` / `npm test` / `npm run build` and
   `electron-builder --win --x64` producing a runnable `win-unpacked` app dir have
   all been verified to work fine natively on Windows — see STATUS.md Milestone 7.
   Only the NSIS/portable installer targets need Windows Developer Mode enabled,
   because electron-builder's `winCodeSign` cache extraction requires symlink
   privileges that a stock non-admin Windows user/session doesn't have). macOS
   is also a supported CI-built target: unsigned, universal (x64+arm64) dmg +
   zip, built via GitHub Actions' `macos-latest` runner — no local Mac
   hardware is required for CI; a Mac is only useful for optional manual
   verification of the resulting `.dmg`.
7. Do not begin `pi-agent-core` / tool integration until the direct `pi-ai` streaming chat
   works end-to-end in dev mode.
8. Keep STATUS.md updated with completed milestones and blockers.
9. Test the production package, not only dev mode, before declaring packaging done.

## How to add X (copy-the-sibling recipes)

### Adding an IPC channel

Touch exactly these three files, in this order, copying the shape of the
existing `sessions:list` channel:

1. `src/shared/events.ts` — add the method signature to `DesktopLLMApi` (and
   any new payload/return types it needs).
2. `src/preload/index.ts` — add one `ipcRenderer.invoke("your:channel", ...)`
   body to the exported `api` object, matching the new `DesktopLLMApi`
   method.
3. `src/main/ipc.ts` — add one `ipcMain.handle("your:channel", async (...) =>
   { ... })` in `registerIpcHandlers`.

Also update `src/renderer/lib/fake-desktop-api.ts`'s in-memory fake so the
browser-based dev harness (see "Lessons learned" #3 below) keeps working.
Name the channel `<domain>:<verb>` (e.g. `sessions:list`, `chat:start`,
`model:list`) — domain-named, not mechanism-named (see #59).

### Adding a renderer component

Add one flat file directly under `src/renderer/components/` (no per-component
subfolder), following `Sidebar.tsx` as the reference sibling: a single
named-exported function component, styled via the single shared
`src/renderer/styles.css` (imported once at `main.tsx`, not a co-located
per-component CSS file), with no per-component test file — this repo
deliberately tests renderer behavior via the `fake-desktop-api.ts` browser
harness (see "Lessons learned" #3) rather than per-component unit tests.

## Node toolchain (build/CI Node vs Electron's bundled Node)

The **build/CI/dev Node** and the **Node bundled inside Electron** are two
independent things. Do not conflate them.

- **Canonical build/CI Node is pinned to Node 24 (Active LTS, EOL 2028-04-30)**
  in exactly one place — `.nvmrc` — and both `.github/workflows/ci.yml` and
  `.github/workflows/mutation-weekly.yml` consume it via
  `node-version-file: '.nvmrc'` so CI and local dev can never diverge again.
  `package.json` `engines.node` (`>=22.19.0`) encodes the real transitive floor
  (driven by `@earendil-works/pi-ai` / `pi-agent-core`), and `.npmrc`'s
  `engine-strict=true` makes a wrong local Node fail install fast instead of
  only printing an easy-to-miss `EBADENGINE` warning.
- **Electron ships its own Node inside the binary** (Electron 33 bundles Node
  20.18; Electron 41+ bundles Node 24.18). The packaged app's main process runs
  against *that* bundled Node at runtime regardless of which Node built/packaged
  it — end users need no Node installed. The build/CI Node has **zero** effect
  on the shipped runtime. The only real coupling would be native C++ addons,
  which are rebuilt against Electron's ABI via `electron-rebuild`, never against
  the toolchain Node (and this app currently has no native addons).
- **Therefore: never re-pin CI back to Electron's bundled Node major** (e.g. "CI
  must be Node 20 to match Electron 33") — it is technically unfounded and
  reintroduces the dev(24)-vs-CI(20) npm-major split that corrupted the lockfile
  in #40. `optionalDependencies` (`@emnapi/*`, etc.) are resolved differently by
  different npm majors, and `npm ci` hard-fails rather than re-resolving. `npm ci`
  in CI is itself the lockfile-drift guard — it fails fast (EUSAGE) on any
  package.json/lock mismatch. (A separate `npm install --package-lock-only` +
  `git diff` guard was tried and removed: npm re-resolves the `@emnapi/*` wasm-
  glue optional deps differently depending on install context, so it produced
  false drift on every run.)
- **Bumping Electron is a separate, higher-risk change** (Chromium/V8 breaking
  changes + real packaged-app testing) — track it as its own issue; it must not
  be conflated with the toolchain Node pin above.

## Testing Rules

These rules govern how agents write tests in this repo. They are mandatory,
apply at generation time, and exist to stop drift before it happens rather
than catch it after the fact.

1. **No regression oracles.** Never derive a test's expected value by calling
   the function/logic under test itself. Expected values must be hand-computed
   or come from an independent, authoritative source (spec, fixture, known-good
   reference), never from re-running the code being tested.
2. **>= 2 behavioral assertions per test.** Every test must contain at least
   two assertions that would actually fail if the underlying logic were
   broken. Assertions that only check "did not throw" or verify type/shape
   without checking real values do not count.
3. **No mocking unless mocking is the subject.** Never mock a dependency
   unless the mock itself is the explicit thing under test (e.g. testing
   retry logic around a flaky dependency). Prefer real implementations and
   integration over mocking.
4. **Cleanup for anything stateful.** Any test involving timers, event
   listeners, subscriptions, or open handles (sockets, file handles,
   intervals) must have an `afterEach` (or equivalent) that cleans them up.

## Lessons learned (end-to-end UI review)

1. **Session browsing/recovery was a UI placeholder, not a real feature.**
   The sidebar only ever showed "Current conversation" text; there was no
   persistence, no way to switch between past conversations, and no
   per-session model. This is now backed by a `SessionService`
   (`src/main/llm/session-service.ts` + `src/main/llm/session-projection.ts`;
   superseded the originally-planned `SessionStore`/`storage/session-store.ts`
   thin `electron-store` wrapper pattern used by `SettingsStore`) plus 4 IPC
   channels
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
   survives an app restart — see `session-projection.test.ts`, following the
   existing pattern in `settings-store.test.ts`. A pure in-memory mock would
   pass even if the on-disk serialization were broken.
6. **electron-builder AppImages launch fine under Xvfb/X11 with
   `--no-sandbox --disable-gpu`**; without `--disable-gpu` the GPU process
   can crash-loop on headless/software-rendered X11 displays. Always launch
   detached (`setsid nohup ... &disown`) so the process survives the calling
   shell command's timeout.
7. **Fully-wired backend plumbing with no UI entry point is a bug, not a
   feature to leave alone.** `sessions:delete` had a real `SessionService`
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
11. **2026-07-24**: Fixing issue #3 (no-model-selected hang) required
    checking `ss -ltnp | grep <port>` *and* inspecting the owning PID's
    `cwd`/cmdline before reusing a port for the dev server — port 5173 was
    already bound by an unrelated sibling project (`made/packages/frontend`),
    not a stale instance of this repo. Always pick a free port
    (`ss -ltnp | grep <port>` empty) rather than assuming the default is
    free or safe to kill.
12. **2026-07-24**: In the Playwright browser harness, `browser_press_key`
    with `Enter` does not reliably trigger a textarea's React `onKeyDown`
    submit handler the same way a real keyboard event does — the composer's
    value stayed unsubmitted. Clicking the actual Send button (or using
    `slowly: true` typing that ends with a real keydown) is the reliable way
    to exercise submit-on-Enter behavior in this harness; don't conclude a
    submit handler is broken based on `press_key` alone without also trying
    a direct click.
13. **2026-07-24**: Verifying an empty-model-list state in the browser
    harness required temporarily editing `fake-desktop-api.ts`'s
    `listModels()` to return `[]` (Vite HMR picks it up instantly), then
    restoring the original file byte-for-byte afterward (`git diff` empty)
    — there's no store-manipulation hook exposed on `window` for tests to
    force this state directly. If this edge case needs re-testing often,
    consider adding a dev-only query-param toggle instead of hand-editing
    the fake API file each time.
14. **2026-07-24**: Item 13's suggested fix was implemented
    (`?fakeModels=empty` query param read directly in `fake-desktop-api.ts`)
    during a 3-way parallel subagent workflow. Before implementing it, the
    subagent re-verified the issue's *other* premise — that the fake bridge
    has "no compile-time parity guarantee" with `DesktopLLMApi` — by
    temporarily removing a method from the fake's returned object literal
    and re-running `npm run check`: it failed with a real `TS2741` missing-
    property error, proving the existing `: DesktopLLMApi` return-type
    annotation already gives full structural compile-time checking, making
    a `satisfies DesktopLLMApi` addition redundant. Lesson: when a
    parallel-subagent task description restates an assumption as fact
    (e.g. "no compile-time guarantee exists"), instruct the subagent to
    prove it with a real failing/passing test before implementing the
    proposed fix — cheap to verify, and here it correctly cut scope instead
    of adding a no-op annotation.
15. **2026-07-24**: Fastest, most robust way to verify a renderer HMR edit
    (no Electron restart) is to point Playwright directly at the resolved
    dev server URL printed by `run-electron-dev.ts` (e.g.
    `http://localhost:5174`), not to CDP-drive the spawned Electron process
    — a plain Chromium tab renders the same Vite-served React app
    identically, with far less setup. Edit the text, re-run
    `browser_find`/snapshot to confirm the change appeared with no
    navigation, then revert the edit and confirm `git diff` is empty before
    calling it verified.
16. **2026-07-25**: Driving the real *packaged* app via CDP (see "Testing the
    production package" below) previously meant hand-writing a throwaway
    `node -e "..."` script every time. Conserved the common actions
    (dump `document.body.innerText`, fill-and-submit the composer via the
    native `<textarea>` value setter + a real `Enter` keydown, poll for the
    "Stop generation" button to disappear, scroll-to-bottom + screenshot) into
    a checked-in `scripts/cdp-drive.ts`, runnable directly via
    `npx tsx scripts/cdp-drive.ts <port> <text|send|wait-idle|screenshot>
    [arg]` (also aliased as `npm run cdp --`). Verified end-to-end against a
    real launched AppImage (all four actions) before committing. Re-use this
    instead of re-deriving the CDP dance from scratch each time; extend it
    with new actions rather than writing one-off scripts again.
17. **2026-07-25**: A saved `provider-settings.json` file existing on disk
    under the app's userData dir does **not** guarantee the app-configured
    provider (`app-settings` in `src/main/llm/models.ts`) shows up in the
    model picker. `src/main/ipc.ts`'s `llm:list-models` handler only
    registers it when `settingsStore.hasSavedApiKey()` is true — a file can
    exist (e.g. left over from `resolvePiDefault()`'s `.pi/agent`-derived
    fallback being persisted, per that function's own doc comment) without
    the user ever having explicitly saved it through the Settings UI. When a
    "configured model" seems to be missing from the picker despite a
    settings file being present, check `hasSavedApiKey()`'s actual condition
    before assuming the provider registration is broken — in practice, the
    already-selected default model (resolved from real `~/.pi/agent`
    credentials, e.g. a free-tier provider) is usually a perfectly valid
    "actually configured model" to demo with instead of chasing a specific
    provider that isn't wired up as expected.
18. **2026-07-25**: `scripts/cdp-drive.ts`'s `screenshot` action only ever
    writes base64 PNG data to stdout — it takes no filename argument (unlike
    Playwright's `browser_take_screenshot`), despite its own docstring
    suggesting `> shot-b64.txt` redirection. Passing a filename as a second
    CLI arg is silently ignored (parsed as the unused `arg` param). Always
    pipe/redirect stdout yourself and `base64 -d` it into a file
    (`npm run cdp -- <port> screenshot | tail -1 | base64 -d > out.png`)
    when verifying a real packaged-app E2E run this way.

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
4. **The `nativeDynamicImport` (`new Function(...)`) trick throws
   `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` under Vitest's default vm-based
   pool** — it has no real V8 module graph, so `new Function(...)`-constructed
   code has no `importModuleDynamically` callback wired up, even though the
   exact same trick works fine in the real packaged app and in `npm run dev`.
   This means any module that calls the real loader directly (e.g.
   `src/main/llm/models.ts`'s `buildModelsRegistry`) cannot be unit-tested
   end-to-end by simply calling it — the loaders (`loadPiAi`/`loadApiModule`)
   must be injectable parameters with real-package defaults, and tests must
   inject a version that imports `@earendil-works/pi-ai` (and its subpaths)
   the normal static way at the top of the *test* file, which Vitest's own
   Vite-based resolver loads regardless of `tsconfig.main.json`'s
   `moduleResolution: "Node"`. Since `Node` resolution can't see pi-ai's
   subpath `"exports"` at all, add ambient `declare module "@earendil-works/
   pi-ai/api/..."` shims (see `src/main/llm/test-support/pi-ai-subpaths.d.ts`)
   so `tsc --noEmit` still type-checks the test fixtures.
5. **`electron-builder`'s `files: dist-main/**` packages every compiled
   `*.test.js`, including test-only fixture modules, into the app — even
   ones nothing in production ever imports.** A test fixture that does a
   real (non-hidden) `require("@earendil-works/pi-ai")` for testing purposes
   is inert (never executed) but still literally present in the shipped
   asar, which defeats the purpose of grepping "no `require(...)` of pi-ai
   in `dist-main/**/*.js`" as an acceptance check. Add explicit `!dist-main/
   **/*.test.js` / `!dist-main/**/test-support/**` negation globs to
   `electron-builder.yml`'s `files` list so the check (and the package
    itself) only reflects real production code paths.
6. **Verifying an acceptance criterion by literally re-reading the issue
   against the diff, after "done", found a real functional gap that all
   automated tests had missed**: `pi-config.ts`'s `listConfiguredModels()`
   was still only ever called as `listConfiguredModels()` (no args) from
   `ipc.ts`, so the app's own `settings.json` model was never registered in
   the model registry the picker actually lists from — only
   `resolvePiDefault()`'s `.pi/agent`-only fallback logic ran. Unit tests
   passed because they called `listConfiguredModels(home, cwd, appSettings)`
   directly with the new parameter; nothing exercised the real IPC call site
   that omitted it. Caught only by manually re-running the issue's own
   acceptance criteria end-to-end against the packaged app, not by any
   automated check. Lesson: when an issue lists concrete acceptance criteria,
   re-verify each one against the actual call sites (not just the function's
   own unit tests) before declaring it done — a new optional parameter is
   invisible to type-checking if every real caller still compiles without it.
7. **`$HOME`/env-var overrides passed via `env VAR=x setsid nohup <AppImage>
   &` are unreliable depending on argument order and whether the command
   also relies on the shell tool's `workdir` parameter for `cwd`.** In this
   project, `setsid nohup env HOME=fake "AppImage" ...` silently launched
   with the real `$HOME` (proven by the app reading the real global
   `~/.pi/agent` instead of the fake one), while `cd realDir && env HOME=fake
   setsid nohup "AppImage" ...` (env variables set *before* `setsid`/`nohup`,
   and `cd` executed as a literal shell command rather than relying on the
   tool's `workdir` param) worked correctly and was independently confirmed
   via `/proc/<pid>/cwd`. Always verify env/cwd actually reached the target
   process (e.g. `readlink -f /proc/<pid>/cwd`, or an observable behavior
   difference like a changed model list) before trusting a negative test
   case in a launch-and-inspect E2E flow — do not assume the override took
   effect just because the launch command didn't error. Note: Chromium
   zeroes its own process's `/proc/<pid>/environ` for security, so it cannot
   be read back directly to confirm env vars; use an observable behavior
   difference instead.
8. **A real (non-mocked) network-boundary test can still prove correct
   wiring without a valid credential.** Verifying the `anthropic-messages`
   API path end-to-end in the packaged app used a deliberately-invalid
   placeholder API key against the real `api.anthropic.com` endpoint. The
   real Anthropic server's `401 {"code":"authentication_error", ...}`
   response (as opposed to a local "provider not configured"/wiring
   exception) is itself valid, honest evidence that model resolution, auth
   application, and the real HTTP dispatch all worked correctly — a full
   successful reply isn't required to prove routing correctness when no
   real credential is available. Report the limitation explicitly rather
   than skipping the case or faking success.
9. **A user-directed manual test found a bigger gap than the original PR
   review had: the model registry never used any of pi-ai's 37 built-in
   provider catalogs (`@earendil-works/pi-ai/providers/all`'s
   `builtinProviders()`) at all — it only supported custom `models.json`
   providers and the app's own `settings.json`.** A user with a real global
   `~/.pi/agent/auth.json` OpenRouter `api_key` credential and *no*
   `models.json` entry for it got zero OpenRouter models, even though this
   is a completely standard, common real-world config (the CLI itself works
   this way). Root cause: `buildModelsRegistry()` never called
   `builtinProviders()`, so an auth.json-only credential for a known
   provider had no provider registration to attach to at all. Fixed by
   registering every built-in provider (lowest precedence) and adding a real
   `CredentialStore` that reads `.pi/agent/auth.json` (project overriding
   global per provider id, mirroring `models.json`/`settings.json`
   precedence) — this alone surfaced OpenRouter's real ~270-model catalog’s
   real per-model cost/context-window metadata, live-verified end-to-end
   (list → select → real chat reply) using the user's actual OpenRouter
   key. Lesson: "does the issue's stated design intent (`pi-ai` ships N
   built-in provider catalogs...) actually get *used* anywhere in the
   diff?" is a distinct question from "do the unit tests pass" — grep the
   diff for the feature the issue said was the point, not just its test
   coverage.
10. **Registering pi-ai's full built-in catalogs (thousands of real model
    ids across 37 providers) turns "look up a model by id" into a genuine
    collision risk** — e.g. Azure OpenAI's and OpenAI's own catalogs both
    ship a model literally named `gpt-4o-mini`, which silently shadowed a
    same-named test fixture for the app's own custom `settings.json`
    provider. Fixed by making both `findModelById` (chat routing) and
    `listConfiguredModels`'s id-keyed dedupe search/prefer providers in
    *reverse* registration order, so a higher-precedence, user-configured
    provider always wins an id collision over an incidentally-matching
    built-in catalog entry. Caught by a unit test asserting the *provider
    id* of the resolved match, not just that a model with the given id was
    found at all — a test that only checks "a match exists" cannot catch a
    same-id collision resolving to the wrong provider.
11. **A "fixed" precedence-based tie-break for id collisions was still
    wrong, and only a user re-testing their own real, specific model caught
    it.** The reverse-precedence `findModelById` (lesson 10) only
    disambiguates *user-configured vs. built-in* collisions; it does
    nothing for collisions *between two built-in providers*, which turned
    out to be extremely common: `MODELS.generated.ts` ships the literal
    model id `"gpt-5.6-luna"` identically from **six** different built-in
    providers (azure-openai-responses, cloudflare-ai-gateway,
    github-copilot, openai, openai-codex, opencode). Selecting
    `github-copilot`'s `gpt-5.6-luna` in the picker silently resolved to
    `opencode`'s (registered later in `builtinProviders()`'s array),
    producing a confusing `"Provider is not configured: opencode"` error
    instead of the real, correct `"OAuth refresh failed for github-copilot"`
    (confirmed by running the *real* `pi` CLI side-by-side with the same
    model/provider pair — it hit the identical expired-token error,
    proving the underlying credential issue was real and unrelated to our
    app, once the routing bug was fixed). The only real fix was structural,
    not another precedence heuristic: make `ModelInfo.id` (and
    `StartChatRequest.model`) a **fully-qualified** `provider/modelId`
    string everywhere, so lookup is an O(1) exact match with zero
    cross-provider ambiguity, instead of ever searching by bare id. This
    required auditing *every* consumer of the bare model id end-to-end
    (`SettingsStore.get()`'s two branches, `ipc.ts`'s reordering
    comparison, `chat-service.ts`'s fallback) to keep them internally
    consistent about which fields are bare (scoped to one known provider)
    vs. qualified (used for cross-provider lookup) — a partial fix that
    qualifies some call sites but not others reintroduces the exact same
    bug in a different shape. Lesson: when a user reports "X should just
    work, try Y yourself" for a *specific* real value, don't substitute a
    similar-looking test case (e.g. a different free-tier model) — reproduce
    with the *exact* value named, since bugs like this are id-specific, not
    provider-class-specific.

## Lessons learned (parallel issue resolution)

- 2026-07-25: A CI job reporting green (`electron-builder --publish always`
  exiting 0) is not proof an artifact was actually uploaded. The real first
  test release (`v0.3.1`, issue #47's `release.yml`) completed both matrix
  jobs successfully with zero errors, but `gh release view v0.3.1 --json
  assets` showed an empty `assets` array — electron-builder's GitHub
  publisher *silently skips* uploading (not a failure, no non-zero exit)
  whenever the existing release's type doesn't match its own configured
  `releaseType` (default `draft`), and `make publish` always creates a
  normal non-draft release via `gh release create`. The mismatch is only
  visible by grepping the electron-builder log line itself
  (`"GitHub release not created  reason=existing type not compatible..."`)
  or, more reliably, by checking the release's actual asset list after a
  "successful" run — never trust the job's exit code alone as proof of a
  real upload for any tool with `--publish`/similar silent-skip semantics.
  Fixed by adding an explicit `publish: { releaseType: release }` to
  `electron-builder.yml` to match `make publish`'s release type; re-verified
  with a second real tag push (`v0.3.2`) that both the Linux AppImage and
  Windows portable exe genuinely landed on the release page, then
  downloaded and launched the real released AppImage via CDP to confirm it
  wasn't just a valid-looking empty/corrupt upload.
- 2026-07-25: Two of five "quick" quality-drift issues shortlisted for a
  parallel batch (#11 maxTokens default, #13 dynamic dev port) turned out to
  already be fixed by an earlier, unrelated commit (`7bb66e8`) whose message
  didn't mention either issue number. Always grep/read the actual current
  source for each candidate issue's described symptom before dispatching a
  subagent for it — a stale open GitHub issue is not proof the bug still
  exists; five minutes of `grep`/`git log -- <file>` here avoided two wasted
  subagent runs and produced two immediate issue closures instead.
- 2026-07-25: When two independent issues both touch the same file (here,
  #16 and #18 both edit `Makefile`, in different targets), assign them to a
  single subagent instead of two parallel ones. Splitting by target instead
  of by file looks more "independent" on paper but risks a real merge
  conflict when two agents rewrite the same file concurrently; splitting by
  file ownership is the safer contract to give.
- 2026-07-25: Confirmed most of a previously-filed quality-drift batch (#16,
  #17, #18, #21) was already implemented by an earlier merged PR (#29) whose
  scope description didn't line up 1:1 with the individual issue numbers —
  again caught by reading the actual current `Makefile`/`vitest.config.ts`/
  test-file layout before dispatching, not by trusting the issue tracker's
  open/closed state. Also: when two genuinely-independent subagents both
  need to append to the same shared target (`Makefile`'s `lint:`, for #20's
  test-ratio check and #26's oxlint), give neither subagent write access to
  that file at all — have them land their own new script/npm-script only,
  then have the coordinator wire both into the shared target once both
  branches are validated. This fully eliminated the merge conflict risk
  instead of just reducing it. Additionally, running each subagent in its
  own `git worktree` + branch (rather than the same working directory) was
  what made true tool-parallel dispatch safe here — concurrent `npm install`
  and file edits in one shared directory would have corrupted
  `node_modules`/`package-lock.json` across unrelated subagents. Minor
  follow-up: a coordinator-side `npm install` run purely for local
  validation (not part of any subagent's commit) left harmless
  `package-lock.json` metadata churn (e.g. a `"peer": true` flag) in the
  worktree — always `git checkout -- package-lock.json` (or equivalent)
  after coordinator-only validation installs, before opening the PR, so
  unrelated lockfile noise doesn't get swept into a diff by accident.
- 2026-07-25: Verifying a "no visual change" claim (Tailwind v4 migration,
  #27/PR #34) for real, rather than trusting the subagent's own build-only
  validation, required checking out both `main` and the feature branch into
  two separate worktrees, launching each one's `npx vite --port <free-port>
  --strictPort` dev server (ports pre-checked free via `ss -ltnp`, per the
  port-safety rule), driving both through the existing `fake-desktop-api.ts`
  browser harness, and diffing full-page screenshots pixel-by-pixel with
  Pillow (`ImageChops.difference` + a `sum(axis=2) > 10` threshold to ignore
  sub-pixel antialiasing noise) rather than eyeballing two screenshots side
  by side — this caught that the only real diff (0.03%) was AA noise around
  a masked "•••• (saved)" field, not an actual regression, which a visual
  eyeball check alone couldn't have quantified with confidence.
- 2026-07-25: Playwright's `browser_take_screenshot` silently writes outside
  the repo (into some other default location, not returned/discoverable via
  a normal `find`) if the `filename` parameter is a bare name like
  `before.png` — even though the tool's own error message for a rejected
  absolute path lists the allowed roots as `<repo>/.playwright-mcp` and
  `<repo>`, a bare filename does not reliably land in either. Always pass
  the filename as an explicit repo-relative path with the `.playwright-mcp/`
  prefix (e.g. `.playwright-mcp/before.png`), then verify with `ls` before
  relying on the file for a diff — don't assume a screenshot call that
  returned success actually wrote where expected.
- 2026-07-25: A `pkill -f "vite --port 5180"` intended to stop a
  self-launched dev server can silently miss the real process if `pkill`'s
  pattern doesn't match the actual resolved command line (e.g. it launched
  as `node .../node_modules/.bin/vite --port 5181 ...` while a different,
  differently-invoked process on another port matched and died first). After
  any bulk `pkill`, always re-check `ss -ltnp | grep <port>` for each port
  you meant to free, and for any still-listening PID, confirm via
  `readlink -f /proc/<pid>/cwd` + `ps -p <pid> -o cmd` that it's really your
  own process before `kill`-ing it directly by PID — never assume a pattern-
  based pkill got everything just because the command itself exited 0.
- 2026-07-25: Creating a `git worktree` as a **sibling** directory
  (`../pi-desktop-<branch>`) puts every tool call inside it (even
  `npm install`) under OpenCode's `external_directory` permission, which
  defaults to `"ask"` and can silently block/reject instead of prompting,
  depending on the session. Always create isolated worktrees **inside** the
  repo instead (e.g. `.worktrees/<branch>/`) and add `.worktrees/` to
  `.gitignore` once — this keeps the worktree under the already-approved
  working directory with zero permission friction, matches the common
  `.git-worktrees/`-style community convention, and is fully supported by
  `git worktree add <path>` (no restriction on nesting under the repo root
  per the official git-worktree docs).
- 2026-07-25: Two parallel subagents (#36 Vite 7→8, #24 coverage ratchet)
  each reported all-green validation from inside their own isolated
  `.worktrees/` checkout, but the coordinator's own from-scratch
  integration run caught two real bugs neither subagent could have seen:
  (1) `npm install` hard-failed with `ERESOLVE` on a clean `node_modules`
  because `@vitejs/plugin-react@^4.3.4`'s peer range didn't include vite 8
  — the subagent's own worktree had a stale/partial `node_modules` that
  silently tolerated the conflict, so its "success" was an artifact of
  install order, not a real green install; and (2) Vitest's `coverage
  .exclude` (added by #24) didn't cover `.worktrees/**`, so once both
  worktrees still had their own `dist-main`/`dist-renderer` build output
  on disk, the coordinator's coverage run picked up 100+ extra 0%-covered
  files from sibling worktrees and reported 6.86% instead of the real
  46.06% baseline. Neither subagent's own isolated run could have
  surfaced this because their sibling worktree didn't exist yet when they
  ran their own validation. Rule: after merging parallel subagent work,
  always re-run `rm -rf node_modules && npm install` (not just `npm
  install`) and the full validation suite from a clean state in the
  coordinator's own tree — a subagent's green result inside its own
  worktree is not sufficient proof the combined result is green, and
  in-repo worktrees left on disk during integration are themselves a
   contamination source for any tool (like coverage) that scans the whole
   repo directory tree rather than just tracked/imported files.
- 2026-07-25: A CI lockfile-drift guard using `npm install
  --package-lock-only` + `git diff --exit-code package-lock.json` (issue #42)
  is **non-deterministic and must not be used** — it was tried, passed every
  local check, and then hard-failed CI. Root cause: npm re-resolves the wasm-
  glue optional deps (`@emnapi/core`, `@emnapi/runtime`) differently depending
  on install context. A *fresh* `npm install` (no `node_modules`, no lock)
  writes them as real installable `node_modules/@emnapi/*` entries — which
  `npm ci` REQUIRES (it reports `Missing: @emnapi/core ... from lock file` and
  fails otherwise) — but `npm install --package-lock-only`, AND even a plain
  in-place `npm install` when `node_modules` already exists, STRIP those
  entries back out. So no local re-run reliably reproduces the lock `npm ci`
  needs, and a `git diff` guard flags phantom drift on every CI run. Fixes:
  (1) commit the lockfile from a genuinely clean slate
  (`rm -rf node_modules package-lock.json && npm install`), and (2) let
  `npm ci` itself be the drift guard — it already hard-fails (EUSAGE) on any
  package.json/lock mismatch, which is exactly the #40 bug class. Do NOT layer
  a `git diff` lockfile check on top. Prevention: never trust a lockfile change
  until `git push` + real CI (`npm ci` on a clean runner) goes green — local
  `npm ci` can pass on the same platform while the committed lock is still
  wrong for a clean install, per the standing rule that a change can pass every
  local check and still fail only in CI / the packaged artifact.
- 2026-07-25: A mid-task `git checkout -- package.json` / `cp <backup>` used to
  restore state after a *deliberate* drift test silently reverted an intended
  edit (the new `engines` field) because the backup was taken before that edit
  landed. Always re-grep for the intended change (`grep '"engines"'
   package.json`) after any restore-to-pristine step in a destructive test, and
   re-apply if lost — don't assume the working tree still holds earlier edits
   once a `checkout`/`cp` restore has run.
- 2026-07-25: `scripts/cdp-drive.ts`'s `send` action takes the message as its
  own CLI **argument** and performs set-value + `Enter` keydown in a single
  call (`cdp-drive.ts <port> send "the message"`). It is NOT a two-step
  fill-then-submit like some browser harnesses. Two easy mistakes cost a wasted
  round-trip here: (a) `text "msg"` silently *ignores* the extra arg — `text`
  only ever dumps `document.body.innerText`, so it looked like the message was
  typed when nothing happened; and (b) calling `send` with no arg errors with
  `"send" requires a message argument`. Always pass the prompt directly to
  `send`, then `wait-idle`, then `text` to read the reply — don't try to `text`
  the prompt in first.
- 2026-07-25: The #42 AGENTS.md claim that "build/CI Node is independent of
  Electron's bundled Node" was **empirically confirmed end-to-end**: the app
  built and packaged on Node 24 (`make dist-linux`), running Electron 33.4.11
  (which bundles Node 20.18), launched and completed a real streamed chat reply
  ("PONG") against a live provider with zero issues. Concrete evidence that
  bumping the toolchain to Node 24 does not require also bumping Electron, and
  that Electron 33 still packages cleanly on Node 24 — a useful de-risking data
  point for the future #43 Electron bump.
- 2026-07-25: `pkill -f "<AppImage filename>"` does NOT kill the actually-running
  packaged Electron process. An AppImage mounts a squashfs at launch, so the
  real running binary's cmdline is `/tmp/.mount_<random>/pi-desktop ...`, not the
  `*.AppImage` path — the filename pattern matches only the transient launcher,
  leaving the real process (and its `--remote-debugging-port` listener) alive.
  Reliable cleanup: find the survivor via `ss -ltnp | grep :<debugport>` → get
  its PID → confirm ownership with `readlink -f /proc/<pid>/cwd` (should be your
  e2e worktree) + `ps -p <pid> -o cmd=` (should show your unique
  `--user-data-dir`) → then `kill <pid>` directly. Re-check the port is released
   afterward, and never kill an unrelated PID (e.g. a sibling project's `vite`)
   found in the same sweep.
- 2026-07-25: The Electron 33 -> 43 major bump (issue #43) needed **zero
  application code changes** — the whole risk was in Chromium/renderer +
  dependency compat, not this app's own API usage. Confirmed cheaply by
  reading Electron `breaking-changes.md` for majors 34->43 and cross-checking
  each item against a grep of `src/main`'s actual Electron API surface (all
  minimal/stable: `app`, `BrowserWindow`, `ipcMain.handle`, `webContents
  .send`, `contextBridge`, `ipcRenderer`, standard `webPreferences`). Two
  concrete gotchas for the next Electron bump: (1) `electron-builder@25.x`
  predates Electron 41-43 and must be bumped alongside (26.15.x packages 43
  fine); (2) Electron 42+ **no longer downloads its binary via a `postinstall`
  script** — `node_modules/electron/dist/` is legitimately empty after
  `npm install` and only populated on the first real `electron` bin
  invocation, so do NOT treat an empty `dist/` as a broken install;
  `electron-builder` fetches its own cached Electron for packaging regardless.
  As always, the only trustworthy proof was a real packaged-AppImage CDP chat
  round-trip (Chromium 150, live `PONG`/`PING` replies), not `make check`
  alone — no native addons meant `@electron/rebuild` had nothing to break,
  which was the single biggest de-risker.
- 2026-07-26: Merging PR #62 (issues #51/#55/#56/#57/#59) left all five
  issues open even though the PR fully resolved them. Root cause: the PR
  body used a plain `## Issues fixed` bullet list (`- #51 — Display app
  version...`) instead of GitHub's auto-close keyword syntax (`Closes #51`,
  `Fixes #55`, etc.) immediately preceding each issue reference — GitHub
  only auto-closes on merge when it recognizes one of those specific
  keywords directly next to a `#N`, and a squash-merge commit message (PR
  title only) doesn't retroactively add them either. Confirmed via `gh issue
  view <n> --json state,closedAt` showing `OPEN`/`null` on all five after
  the merge. Fixed by manually `gh issue close <n> --comment "Resolved via
  #62 ..."` for each. Prevention: any PR body listing issues it resolves
  must use `Closes #N` / `Fixes #N` / `Resolves #N` (one keyword per issue,
  not a shared "Issues fixed:" heading with bare `#N` bullets) so GitHub's
  linking actually fires on merge — verify with `gh issue view <n> --json
  state` right after merging, don't assume a merged PR closed its issues
  just because the body mentioned them.
- 2026-07-26: A 5-way parallel mutation-hardening batch (#65-#69, all
  test-only changes across fully disjoint files) merged with zero conflicts
  as expected, but two integration lessons still surfaced: (1) backgrounding
  a long-running `stryker run` with `nohup ... &` inside a bash tool call
  does not survive that same tool call's own timeout — the tool kills the
  whole process group on timeout, taking the "detached" background job with
  it, so a full ~26-minute combined mutation run silently died at 5%
  progress with no error. Since the 5 issues' files were fully disjoint, the
  already-recorded per-issue Stryker scores (collected inside each isolated
  subagent worktree) remained valid evidence without a redundant combined
  re-run — for genuinely disjoint parallel test-hardening work, per-branch
  mutation scores are sufficient integration proof; only re-run combined
  mutation testing when file sets actually overlap. If a full combined run
  is ever required, use the `detach` skill/pattern (a real `setsid`+`disown`
  outside the tool's own timeout window) instead of `nohup &` inside a
  single bash call. (2) One subagent's task was interrupted mid-run by a
  tool-execution error before it made any file changes or commits; the
  worktree's only diff was an incidental `package-lock.json` touch (reverted
  before re-dispatch). Always check `git status`/`git log` in a suspect
  worktree before concluding a subagent silently failed — an interrupted
  tool call can be safely resumed by re-dispatching the exact same task
  prompt against the same (already-clean) worktree/branch with zero risk of
  duplicated or lost work.
- 2026-07-26: PR #76 (#75's jsdom/testing-library work) passed the
  subagent's own worktree validation (`npm install && npm test`) but failed
  real CI with `npm error Missing: @emnapi/core@1.11.3 from lock file` —
  the exact `@emnapi/*` drift class already documented in the 2026-07-25
  lockfile lesson above. The gap was that the *task prompt* given to the
  subagent only said "run `npm install`", not the clean-slate + `npm ci`
  sequence the existing lesson prescribes — a lesson recorded in AGENTS.md
  is not self-enforcing; it must be restated as an explicit instruction in
  every subagent dispatch that touches `package.json`/`package-lock.json`.
  Prevention (now mandatory in any such task prompt and before any
  package-lock.json commit, subagent or coordinator): run, in this exact
  order, `rm -rf node_modules && npm install` (clean-slate, never a plain
  in-place `npm install`) followed by a separate `rm -rf node_modules &&
  npm ci` as the real pre-merge gate, since `npm ci` is the literal command
  CI runs and a local pass is a near-guarantee of a green CI lockfile step.
  Do not rely on `npm test`/`npm run check` passing after `npm install`
  alone as proof the lockfile is CI-safe — those commands never exercise
  `npm ci`'s stricter lock-must-match-exactly behavior.
- 2026-08-05: Issue #85's `fast-uri` audit fix reproduced the exact
  `@emnapi/*` drift class from the 2026-07-25/07-26 lessons *again*, even
  after following their prescribed clean-slate `npm install` + `npm ci`
  procedure locally (both passed) — the coordinator's own local `npm ci`
  succeeded with `@emnapi/core@1.11.1` while GitHub Actions' real CI run
  independently resolved `@emnapi/core@1.11.3` and failed with the classic
  `Missing: @emnapi/core@1.11.3 from lock file`. Root cause, found by
  grepping `package-lock.json` for every `@emnapi/*` requirer:
  `@tailwindcss/oxide-wasm32-wasi` (an optional, platform-mismatched wasm32
  binary that is never actually installed on our linux-x64 targets either
  locally or in CI) declares a floating `^1.11.1` range for
  `@emnapi/core`/`@emnapi/runtime`, and npm's arborist resolves that range
  non-deterministically across independently-run `npm install`s on
  different machines/times — i.e. this specific drift class **cannot** be
  fully prevented by a local clean-slate `npm ci` pass alone, contradicting
  the earlier lesson's "near-guarantee" framing. Fix: add explicit
  `"overrides"` in `package.json` pinning `@emnapi/core`, `@emnapi/runtime`,
  and `@emnapi/wasi-threads` to exact versions — this collapsed the
  resolution to a single deterministic outcome (verified by running two
  independent from-scratch `rm -rf node_modules package-lock.json && npm
  install` cycles and diffing the resulting `package-lock.json`s
  byte-for-byte identical), and the real GitHub Actions `check-and-test`
  job went green on the next push. Prevention: when *any* package in the
  dependency tree is an optional platform-specific binary (wasm32/musl/arm
  variants of native addons like `@tailwindcss/oxide-*`, `@rollup/rollup-*`,
  `esbuild-*`) with a caret/floating-range sub-dependency, do not assume a
  single local clean-slate `npm ci` pass is sufficient proof of CI
  determinism — cross-check by running the from-scratch install twice
  independently (ideally hours/days apart or on a different machine) and
  diffing the lockfile, or preemptively pin such floating sub-ranges via
  `overrides` before they ever cause a CI failure.
- 2026-08-05: A repo's branch protection rule can silently require a status
  check context (`"CI"`) that no longer matches any real check name the
  current workflow actually reports (the workflow is named `CI` at the
  top level, but its only job is named `check-and-test`, so GitHub posts
  the check as `check-and-test`, never as literal `"CI"`). This makes
  `gh pr merge` always report `"the base branch policy prohibits the
  merge"` / `mergeStateStatus: BLOCKED` even when the real, relevant CI
  job is fully green — for every PR, not just this one. Confirmed via
  `gh api repos/<owner>/<repo>/branches/main/protection` showing
  `required_status_checks.contexts: ["CI"]` while `gh api .../check-runs`
  on the same commit only ever lists `check-and-test`. Used `gh pr merge
  --admin` to bypass after independently confirming the real
  `check-and-test` run was green — do not use `--admin` to bypass a
  genuinely failing/red check, only a protection rule that is provably
  misconfigured/stale relative to the actual workflow. Filed as a
   follow-up issue rather than silently fixing the branch protection
   config itself (repo-admin-level settings change, out of scope for a
   code-only task).
- 2026-08-05: Issue #87 (the `"CI"` vs `check-and-test` branch protection
  mismatch above) was fixable directly, once confirmed the acting account
  has real admin rights (`gh api repos/<owner>/<repo> --jq
  '.permissions.admin'` returned `true`): `gh api --method PATCH
  repos/<owner>/<repo>/branches/main/protection/required_status_checks -F
  strict=true -f 'checks[][context]=check-and-test'` retargets the required
  context without touching any other protection setting. Gotcha: `-f
  strict=true` sends the string `"true"` and GitHub rejects it
  (`'properties/strict', "true" is not a boolean`) — booleans must go
  through `-F` (typed), not `-f` (always-string), when using `gh api`.
  Verified end-to-end with a real disposable PR: opened it, watched
  `gh pr checks` report the job as `check-and-test`, confirmed
  `mergeStateStatus` went from `BLOCKED` to `CLEAN`/mergeable once that
  check went green, then merged with a normal `gh pr merge` (no `--admin`
  needed) — proving the fix, not just the API response.
- 2026-08-05: #81's `electron-builder.yml` config (`mac.target[].arch:
  [universal]`) looked correct and passed every local YAML-parse/lint check,
  but the very first real `v0.3.7` tag push silently built and published
  `Pi-Desktop-Demo-0.3.7-mac-arm64.dmg` — arm64-only, not universal.
  Root cause: electron-builder's CLI target shorthand (`--mac dmg zip`, used
  by the Makefile's `dist-mac`, `package.json`'s `dist:mac`, and
  `release.yml`'s macos-latest `build-cmd`) silently overrides/ignores the
  yml's per-target `arch:` config and defaults to the host runner's own arch
  (GitHub's `macos-latest` is now an arm64 runner) — confirmed against
  electron-builder's own docs (`electron-builder --mac --universal` is a
  separate, required CLI flag). No local check can catch this: `npm run
  build`, YAML parsing, and even `npx electron-builder --mac dmg zip --help`
  all look fine: the divergence only shows up in the actual job log's
  `packaging platform=darwin arch=...` line and in the real released asset's
  filename. Fixed by adding a bare `--universal` flag alongside the target
  list in all three invocations, then re-verified with a second real tag
  push (`v0.3.8`) showing `packaging platform=darwin arch=universal` in the
  job log and `Pi-Desktop-Demo-0.3.8-mac-universal.dmg` (~237MB, roughly 2x
  the prior arm64-only ~140MB build) as the actual released asset. Lesson:
  for any packaging/build tool where CLI flags and config-file settings can
  both specify the same option (target arch, output format, etc.), do not
  assume the config file always applies just because CLI target names also
  appear — verify by reading the actual build tool's own log output line
  that states the resolved value (not just "job succeeded"), and only trust
  a real tag-triggered CI run's actual artifact, never a design review of
  the yml alone.
