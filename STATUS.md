# STATUS

Scope for tonight: Linux only (AppImage). Windows packaging was out of scope
initially, but has since been verified to build and run natively on Windows
(see Milestone 7 below); only the NSIS/portable installer step still needs a
host-side Developer Mode setting.

## Completed milestones

- **Milestone 1 — Bootable shell**: Electron main/preload/renderer boot with
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No Node
  APIs are reachable from the renderer; all access goes through
  `window.desktopApi` (`src/preload/index.ts`).
- **Milestone 2 — Static polished UI**: Sidebar, empty state, composer, model
  picker, settings dialog, Markdown + syntax-highlighted code rendering all
  implemented (`src/renderer/components/*`).
- **Milestone 3 — Provider settings**: OpenAI-compatible API key / base URL /
  model fields persisted via `electron-store` (`src/main/storage/settings-store.ts`).
  The renderer never receives the stored API key back (`getSummary()` only
  returns `hasApiKey: boolean`).
- **Milestone 4 — Streaming chat through pi-ai**: `ChatService`
  (`src/main/llm/chat-service.ts`) streams via
  `@earendil-works/pi-ai` openai-completions API, forwards `text-delta`,
  `usage`, `completed`, and `error` events over IPC. Generation can be
  cancelled via `AbortController`. Errors surface inline through
  `ErrorBanner`.
- **Milestone 5 — Packaging (Linux)**: `electron-builder` produces
  `release/Pi Desktop Demo-0.1.0-linux-x86_64.AppImage`. Verified on a real
  X11 display (`DISPLAY=:0.0`): the AppImage launches, opens an actual
  1280x800 Electron window titled "Pi Desktop", and renders the polished
  welcome screen (screenshot captured via `import -window`, confirms
  Tailwind styling, sidebar, model picker, and composer all draw correctly).
- **Copy actions**: Added copy-to-clipboard for code blocks and full assistant
  responses (previously missing from the mandatory feature list).
- **Milestone 6 — Real session browsing + recovery**: The sidebar previously
  only showed a static "Current conversation" label with no persistence.
  Added `SessionStore` (`src/main/storage/session-store.ts`) + 4 IPC channels
  (`sessions:list|get|save|delete`), wired into `chat-store.ts`
  (`conversationId`, `loadSessions`, `loadConversation`, `persistSession`)
  and a real `Sidebar` session list. Sessions persist their model alongside
  messages, so switching back to an older conversation also restores the
  model it was run with. Verified end-to-end in a real browser against the
  Vite dev server via Playwright, using a tiny in-memory fake of the preload
  bridge (`src/renderer/lib/fake-desktop-api.ts`, only active when
  `window.desktopApi` is missing — never in the real Electron app): sent two
  multi-turn conversations under different models, confirmed both appear in
  the sidebar newest-first, and confirmed clicking an older session restores
  its full message history and its original model. Also re-verified the
  packaged AppImage still boots cleanly with the real IPC bridge (empty
  session list, real `GPT-4o mini` curated model, no fake-mode leakage).

## Critical bug found and fixed during this review

- **First-launch used a hardcoded, always-empty OpenAI provider config,
  showing "No API key configured" before the user could ever chat.**
  Added `src/main/llm/pi-config.ts`, which resolves a ready-to-use default
  provider/model straight from the user's existing `~/.pi/agent`
  configuration (`settings.json` `defaultProvider`/`defaultModel`,
  `auth.json` API keys for known providers, `models.json` custom
  OpenAI-compatible providers with env-var-referenced keys). `SettingsStore`
  now falls back to this resolved default whenever the user hasn't
  explicitly saved their own API key, and `listModels()` surfaces it first
  in the model picker labeled `"<provider>/<model> (from .pi)"`, so it's
  selected by default. Respects the current `.pi` config exactly
  (`defaultProvider: "llm7"`, `defaultModel: "minimax-m2.7"` picked correctly
  out of that provider's multiple listed models, not just the first one).
- **Every chat request would have crashed in the packaged app (never caught
  by unit tests).** Root cause, found via CDP-driven testing of the actual
  built AppImage (not just `npm test`, which always passed): `pi-ai` is
  ESM-only, and `tsconfig.main.json`'s `"module": "CommonJS"` causes `tsc` to
  silently downlevel `await import(x)` into
  `Promise.resolve().then(() => require(x))`. `require()` can never load an
  ESM package, so this threw `ERR_PACKAGE_PATH_NOT_EXPORTED` or `"require()
  of ES Module ... not supported"` at runtime — but only in the
  compiled/packaged app, never in plain-TS unit tests, which is why it went
  unnoticed. Fixed by hiding the dynamic import from tsc's static rewrite via
  `new Function("specifier", "return import(specifier);")` in
  `chat-service.ts`, which preserves a genuine native `import()` at runtime.
  Also made the pi-ai loader an injectable constructor dependency on
  `ChatService` (rather than relying on `vi.mock` module interception, which
  can't see through the same hiding trick), so tests inject a fake loader
  directly.
  - Verified end-to-end against the real packaged, `asar`-enabled AppImage
    (not just `linux-unpacked`): launched via CDP remote debugging, sent a
    real message with no manual settings configured, and received an actual
    model reply ("Confirmed" / "Demo works") from the live `llm7` provider
    using the `.pi`-resolved `minimax-m2.7` model.
  - Re-ran `npm run check`, `npm test` (27/27 passing), and a full
    `make dist-linux` after the fix; all succeed.

## Previously fixed (still valid)

- **Broken pi-ai streaming import subpath**: `chat-service.ts` originally
  imported a subpath not exposed by `pi-ai`'s `exports` map. Fixed to import
  `@earendil-works/pi-ai/api/openai-completions` (the correct exported
  subpath).



## Deliberately out of scope tonight

- Windows portable EXE / NSIS installer (explicitly excluded for tonight per
  task instructions; `dist-win` target still exists in `Makefile` /
  `electron-builder.yml` for later use).
- `pi-agent-core` integration, `list_files` / `read_file` tools (Milestone 6,
  stretch path — direct `pi-ai` streaming works standalone as required).
- Conversation persistence across app restarts, multiple conversations,
  folder selection, `AGENTS.md` loading, themes, provider login flows
  (explicitly optional per docs/INITIAL.md).
- Retry action / first-token timing / keyboard shortcuts polish (Milestone 7
  "demo polish" — not required for the mandatory feature set).

## Known blockers / caveats

- Renderer bundle is a single ~966 KB (331 KB gzip) JS chunk (Vite warning).
  Per docs/INITIAL.md this is explicitly not worth optimizing tonight.
- No `.git` commit history exists yet in this repository; commits were not
  made as part of this review since they were not explicitly requested.

## Verification evidence (last run)

```
npm run check   → tsc --noEmit clean for both tsconfig.json and tsconfig.main.json
npm run test    → 6 test files, 27 tests passed
make dist-linux → release/Pi Desktop Demo-0.1.0-linux-x86_64.AppImage produced (asar: true)
Real display, real IPC, real provider smoke test (CDP-driven, no OS input
  injection) → launched the packaged AppImage on DISPLAY=:0.0, started a new
  chat with zero manual configuration, confirmed the model picker defaulted
  to "llm7/minimax-m2.7 (from .pi)" (resolved from ~/.pi/agent), sent a real
  message, and received an actual streamed reply from the live llm7 provider
  ("Confirmed" / "Demo works") -- proving both the .pi-default-model fix and
  the ESM-import packaging fix work together in the real production build.
```
## Milestone 7 — Windows build verified (2026-07-24)

- Ran `npm install` (810 packages), `npm run check` (clean), and `npm test`
  (6 files, 27 tests passed) natively on Windows 10/11 — all pass unchanged,
  no platform-specific code paths needed.
- `npm run build` (Vite renderer + `tsc` main) succeeds on Windows.
- `npx electron-builder --win --x64` successfully produces an unpacked app
  at `release/win-unpacked/Pi Desktop Demo.exe` (`--dir`-equivalent output).
  Launched it directly (`Start-Process`): a real Electron window titled
  "Pi Desktop" opened and stayed running, confirming the app boots and
  renders correctly on native Windows with no code changes required.
- The NSIS/portable installer targets (`win.target: nsis, portable` in
  `electron-builder.yml`) **fail** on a stock, non-admin, non-Developer-Mode
  Windows machine: electron-builder downloads the `winCodeSign` tool cache
  (used even for unsigned Windows builds) and fails to extract it because
  that archive contains symlinks for the bundled macOS/Darwin lib files —
  `ERROR: Cannot create symbolic link : A required privilege is not held by
  the client.` Creating symlinks without elevation requires Windows
  **Developer Mode** enabled (Settings → For developers), or running the
  build from an elevated shell. Not attempted here (no admin elevation, per
  operational safety rules). The unpacked `win-unpacked` app is unaffected
  and fully runnable without this — only the installer/portable `.exe`
  packaging step needs it.
- Conclusion: Windows is no longer out of scope for running/building the
  app dir; only producing signed-style NSIS/portable installers needs an
  extra one-time host setting (Developer Mode) that wasn't available in
  this environment.

## Milestone 8 — Electron bumped 33 (EOL) -> 43 (2026-07-25, issue #43)

- Bumped `electron` `^33.3.1` -> `^43.2.0` (latest stable; Chromium 150,
  bundles Node 24.18) and `electron-builder` `^25.1.8` -> `^26.15.3`
  (25.x predates Electron 41-43; 26.x packages 43 cleanly). Regenerated
  `package-lock.json` from a clean slate (`rm -rf node_modules
  package-lock.json && npm install`) per the #40/#42 lockfile-drift rule.
- **Zero application code changes required.** Reviewed Electron
  `breaking-changes.md` for every major 34 -> 43 against this app's actual
  API surface (`app`, `BrowserWindow`, `ipcMain.handle`, `webContents.send`,
  `contextBridge`, `ipcRenderer`, standard `webPreferences`). None of the
  breaking changes (clipboard-in-renderer, nativeImage, dialog defaults,
  BrowserView, PDFs, OSR, protocol, extensions, macOS-only items) touch any
  API this app uses. The one operationally-relevant change (Electron 42:
  binary no longer downloaded via `postinstall`, fetched on first `electron`
  bin run instead) does not affect the electron-builder packaging path,
  which fetches its own cached Electron.
- No native C++ addons -> `@electron/rebuild` ran with nothing to rebuild;
  no ABI breakage (the single largest risk reducer, as predicted in #43).
- `make check` green: tsc (renderer + main) clean, oxlint clean, test-ratio
  clean, **50/50 tests pass**, coverage ratchet pass (47.46% >= 46.06%).
- **Real packaged AppImage verified end-to-end via CDP** (zero mocks):
  launched `Pi Desktop Demo-0.2.0-linux-x86_64.AppImage` (Chromium 150
  confirmed), real provider catalogs loaded from `~/.pi/agent`, and a fresh
  two-turn conversation returned correct live streamed replies
  (`PONG` then `PING`) from a real provider HTTP call. This proves the ESM
  `nativeDynamicImport` path for `@earendil-works/pi-ai` still loads at
  runtime under Electron 43 / Node 24 in the packaged asar — a chat is
  impossible without it.