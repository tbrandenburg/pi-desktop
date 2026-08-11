# AGENTS.md Archive: UI and Packaged-App Lessons

This archive preserves the detailed incident narratives removed from `AGENTS.md`
under issue #215. The rules in `AGENTS.md` are the operational reference.

## Session recovery and UI validation

Session browsing began as a placeholder: the sidebar showed only the current
conversation, with no persistence, switching, or per-session model. The fix used
`SessionService`, persisted on completed/error/stop rather than every keystroke,
and added the existing sessions IPC channels. Renderer state needed a
`conversationId`, not a new store or router. Recovery had to restore both messages
and `selectedModel`; restoring messages alone resumed with the wrong model.

The browser harness runs the Vite renderer with an in-memory fake preload bridge
only when `window.desktopApi` is undefined. The packaged preload runs first, so
the fake is absent in production. This harness covered session recovery, model
selection, multi-turn chat, and deletion without opaque Electron pixel driving.
The mandatory journeys were re-run on 2026-07-24 with two fake models and found no
regressions; a favicon 404 was harmless noise.

The backend had a working `sessions:delete` path but no Sidebar entry point. A
hover-revealed delete button completed the user journey: deleting the active
session cleared the pane, while deleting an inactive session removed only its row.

## Browser and CDP findings

The browser automation `Enter` key helper did not reliably invoke the React
textarea submit handler. Clicking Send, or typing slowly enough to generate a
real keydown, was reliable. The empty-model edge case initially required a
temporary fake edit; it was replaced with the `?fakeModels=empty` dev toggle. HMR
verification was fastest against the resolved Vite URL rather than the spawned
Electron process.

The checked-in `scripts/cdp-drive.ts` consolidated text, send, idle-wait, and
screenshot actions for packaged-app validation. Its `screenshot` action emits
base64 to stdout, so callers must redirect and decode stdout; a filename argument
is ignored. Its `send` action reports that a keydown was dispatched, not that the
message was submitted. A second same-tick attempt sometimes succeeds, so always
re-read the page or screenshot to confirm submission.

## Packaged-app validation

Unit tests, dev mode, and Vite do not exercise compiled CommonJS output or the
Electron package layout. A real AppImage must be built and launched detached with
a unique user-data directory, remote debug port, `--no-sandbox`, and
`--disable-gpu`. A stale Electron survivor can own the port even when the shell
reports a timeout. Inspect the port owner, cwd, and command line before killing or
relaunching; AppImage processes use a mounted temporary path rather than the
AppImage filename.

The real packaged acceptance path is a fresh conversation with no manually entered
settings that produces an assistant reply. Slow free-tier providers need 15-45
seconds; rate-limit text is not a hang. A deliberately invalid key can still prove
network wiring when the real provider returns its authentication error instead of
a local configuration error.

The packaged-vs-dev resource test required a negative control. Seeing a bundled
command was ambiguous while both the repository and packaged resource existed.
Moving the packaged resource aside and observing the command disappear proved the
`process.resourcesPath` branch.

## Registry and extension incidents

The model picker initially omitted providers available through pi-ai's built-in
catalogs when only `auth.json` existed. Registering built-ins and reading project
credentials over global credentials fixed the standard auth-only path. Built-in
catalogs then exposed bare-ID collisions, first between configured and built-in
providers and then between multiple built-ins. Reverse precedence fixed only the
first case. The durable fix was fully-qualified `provider/modelId` identifiers,
with every consumer audited: settings lookup, IPC ordering, and chat fallback.

An extension-provider fix passed unit tests but its real entry point omitted the
explicit `agentDir`, causing the library to use the process home directory. Tests
all injected a resource-loader override, which disabled the branch under test. A
production-shaped test without that override caught the issue.

Two early reports claimed extension-registered tools/providers were not wired into
real sessions. A throwaway end-to-end script against the actual package proved
they were wired by the library; only the model picker reload path was missing.
Do not rewrite architecture from static assumptions about a third-party library.

## Activity UI findings

The real packaged UI caught two gaps that isolated tests missed: an activity row
rendered raw milliseconds while a technical trace row formatted seconds, and a
popover flipped upward without checking whether the top edge fit. The fix must
validate every rendered row and both directions of viewport fit with a real
screenshot, not only helper-function tests.

## Configuration and build resolution

Compiled TypeScript rewrote dynamic `import()` into `require()` in CommonJS
output. This failed only in the packaged app for ESM-only pi-ai. Hiding the import
from tsc with a native dynamic-import loader fixed production, while injectable
loaders kept Vitest usable. The package also included compiled test fixtures until
electron-builder negation globs excluded `*.test.js` and test-support files.

Electron's app/asar resolution patches apply only in the real packaged process;
plain Node and `ELECTRON_RUN_AS_NODE=1` were insufficient reproductions. Candidate
asar/path hypotheses had to be toggled one at a time and checked in the actual
artifact. The Electron 33-to-43 review found no application API changes, but
electron-builder compatibility and Electron 42's deferred binary download were
packaging gotchas. Real AppImage CDP chat, not type-checking alone, was the proof.
