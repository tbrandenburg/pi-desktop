# STATUS

Scope for tonight: Linux only (AppImage). Windows packaging is out of scope.

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
