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

- **Broken pi-ai streaming import (would have crashed every chat request in
  production)**: `chat-service.ts` dynamically imported
  `@earendil-works/pi-ai/dist/api/openai-completions.js`. That subpath is
  **not** part of the package's `exports` map (only `./api/*` →
  `./dist/api/*.js` is exposed), so Node's ESM loader throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime. The existing unit test suite
  never caught this because `chat-service.test.ts` fully mocks the module
  under the same (wrong) specifier, so the mock always resolved regardless of
  whether the real path was valid.
  - Fixed to import `@earendil-works/pi-ai/api/openai-completions` (the
    correct exported subpath), stored as a non-literal specifier constant so
    TypeScript's classic `Node` module resolution (which cannot see subpath
    `exports` maps) does not reject the string at compile time while Node's
    real ESM loader still resolves it correctly.
  - Replaced the now-unresolvable `typeof import(...)` type with a manually
    declared `OpenAICompletionsModule` interface built from `pi-ai`'s
    top-level exported types (`Model`, `Context`, `OpenAICompletionsOptions`,
    `AssistantMessageEventStream`).
  - Verified with a real, non-mocked end-to-end call: ran `ChatService`
    directly (via `tsx`) against the live free `https://api.llm7.io/v1`
    endpoint (`gpt-oss:20b`) with a real `LLM7_TOKEN`. Observed the full
    correct event sequence: `started` → `reasoning-delta`* → `text-delta`
    ("BAN" + "ANA") → `usage` → `completed`. This proves the streaming path
    genuinely works against a real provider, not just against test mocks.
  - Re-ran `npm run check`, `npm run test` (13/13 passing), `npm run build`,
    and `npx electron-builder --linux AppImage` after the fix; all succeed.

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
npm run test    → 4 test files, 13 tests passed
npm run build   → renderer + main build succeed
npx electron-builder --linux AppImage → release/Pi Desktop Demo-0.1.0-linux-x86_64.AppImage produced
Real display smoke test → AppImage launched on DISPLAY=:0.0, window
  screenshot confirms the welcome screen renders correctly (Tailwind styling,
  sidebar, model picker, composer all present).
Real (non-mocked) LLM streaming test → ChatService run directly via tsx
  against https://api.llm7.io/v1 (gpt-oss:20b) produced started →
  reasoning-delta → text-delta → usage → completed events with correct
  content ("BANANA").
```
