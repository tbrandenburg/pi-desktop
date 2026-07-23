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
