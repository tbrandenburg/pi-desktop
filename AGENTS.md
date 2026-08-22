# Agent Guidelines

For more details check docs/INITIAL.md.

## Make targets

The Makefile is the source of truth (`make help` always reflects it exactly).

- `make install`: install dependencies.
- `make run`: start dev mode.
- `make run-web`: start dev mode with the opt-in local web bridge (issue
  #228) instead of an Electron window — open the printed Vite dev server
  URL in a plain browser tab to talk to the real backend (real models,
  chat streaming, sessions). Equivalent to `npm run dev:web`.
- `make stop`: stop dev/electron processes started by `make run`.
- `make test`: run unit tests.
- `make lint` / `make check`: type-check renderer and main; do not auto-fix.
- `make build`: build renderer and main for production.
- `make pack`: build and package the app directory without an installer.
- `make dist`: package installers for the host platform.
- `make dist-linux`: package the Linux AppImage.
- `make dist-win`: package Windows NSIS and portable installers; cross-building
  from Linux requires `wine`/`mono`.
- `make clean`: remove build artifacts and `node_modules`.
- `make run-bundled`: run the newest built artifact for the host platform.
- `make run-linux` / `make run-win`: run a specific built Linux/Windows artifact.
- `make install-app` / `make uninstall-app`: install/remove the Linux AppImage
  command and desktop entry; run `make dist-linux` first.
- `make version-patch`, `version-minor`, `version-major`: check and test, bump,
  commit, and tag a release; do not push.
- `make release`: push the release commit and tag.
- `make publish`: create the GitHub release for the current tag.
- `make release-patch`, `release-minor`, `release-major`: bump, push, and publish.

## Architecture rules

1. Keep the Electron + React + Vite + pi-ai architecture.
2. Do not introduce Tauri, Rust, Next.js, or a separate server process.
3. Keep Pi imports inside `src/main/agent` and `src/main/model`.
4. Keep Node and Pi APIs out of the renderer; use the typed preload bridge.
5. Never retain API keys in renderer state after saving; round-trip settings via main.
6. Target Linux AppImage work locally. Windows installer packaging is out of scope;
   macOS artifacts are CI-built unsigned universal dmg/zip files.
7. Do not start pi-agent-core/tool integration before direct pi-ai streaming chat
   works end-to-end in dev mode.
8. Update `STATUS.md` with completed milestones and blockers.
9. Test the production package, not only dev mode, before declaring packaging done.
10. Chat sessions intentionally run the full pi-coding-agent built-in tool set
    without per-call approval UI; issue #133 tracks a future approval UI.

## Copy-the-sibling recipes

### Adding an IPC channel

Touch these three files in order, following `sessions:list`:

1. `src/shared/events.ts`: add the `DesktopLLMApi` method and types.
2. `src/preload/index.ts`: add the matching `ipcRenderer.invoke` binding.
3. `src/main/ipc.ts`: add the matching `ipcMain.handle` implementation.

Also update `src/renderer/lib/fake-desktop-api.ts`. Name channels
`<domain>:<verb>`, such as `sessions:list`, `chat:start`, or `model:list`.

### Adding a renderer component

Add one flat named-export component under `src/renderer/components/`, following
`Sidebar.tsx`. Use the shared `src/renderer/styles.css`; do not add a component
stylesheet or a per-component test. Use the browser fake bridge for renderer UI tests.

## Node toolchain

- Pin build/CI/dev Node 24 in `.nvmrc`; CI consumes that file. Keep
  `package.json`'s real floor (`>=22.19.0`) and `.npmrc`'s `engine-strict=true`.
- Treat Electron's bundled Node as independent from build/CI Node. Do not repin
  CI to Electron's major; bumping Electron is a separate compatibility task.
- Use `npm ci` as the lockfile-drift guard. Do not add an
  `npm install --package-lock-only` diff guard.

## Testing rules

1. Derive expected values independently; never call the logic under test as an oracle.
2. Put at least two behavioral assertions in each test.
3. Do not mock unless the mock itself is under test; prefer real integrations.
4. Clean up timers, listeners, subscriptions, and open handles in `afterEach`.

## Operational rules

- Persist sessions on completed/error/stop, not every keystroke.
- Restore both conversation messages and the model used by that session.
- Use the existing store and IPC patterns before adding abstractions.
- Validate the actual UI entry point for backend plumbing; wired code with no UI path
  is incomplete.
- Use the Vite browser harness and fake preload bridge for renderer journeys. Re-run
  session recovery, model selection, and multi-turn chat checks after related UI changes.
- Check that a dev port is free, inspect its PID/cwd/cmdline, and never kill an
  unrelated process.
- Use CDP for packaged-app interaction; never use OS-level input injection.
- Launch packaged Electron detached with a unique `--user-data-dir`, remote debug
  port, `--no-sandbox`, and `--disable-gpu` under headless X11.
- Before relaunching, inspect the intended debug-port owner, cwd, and command line;
  AppImage survivor processes may not contain the AppImage filename in their cmdline.
- Give slow providers 15-45 seconds and distinguish rate-limit errors from hangs.
- Trust a chat only after a fresh conversation produces an actual assistant reply.
- Never sleep to wait for an observable condition. Poll the condition with a bounded
  timeout and fail with diagnostic context when it does not occur. See
  [timing lesson](docs/lessons/2026-08-11-agents-operational-lessons.md).
- After a configuration/resource failure, audit every guard and construction call
  that consumes the configuration before relaunching. Verify each call site, not
  only the helper and its tests. See
  [configuration lesson](docs/lessons/2026-08-11-agents-operational-lessons.md).
- Batch independent read-only reconnaissance (file searches, status, and reads) in
  parallel before editing. See
  [workflow lesson](docs/lessons/2026-08-11-agents-operational-lessons.md).
- After green subagent validation, limit coordinator duplicate validation to the
  exact CI gates and acceptance paths that add independent evidence. See
  [coordination lesson](docs/lessons/2026-08-11-agents-operational-lessons.md).
- When a subagent test needs an artificial workaround, investigate whether it hides
  the production bug instead of accepting the green result.
- When configs/registries are built at multiple call sites, compare their inputs and
  exercise the real production call shape.
- Verify every issue acceptance criterion against actual call sites and runtime
  behavior; passing unit tests alone is insufficient.
- For packaged-vs-dev resource checks, make candidate paths distinguishable with a
  negative control.
- For dynamic imports in compiled main code, inspect compiled output and keep ESM
  loading injectable for tests. Exclude test fixtures from the package.
- Use fully-qualified `provider/modelId` identifiers where models cross provider
  boundaries; never resolve ambiguous bare IDs.
- Treat a successful quality command as insufficient if its measured output is
  `Unknown`, `0/0`, empty, or otherwise vacuous.
- Run the exact CI commands as the final gate; do not substitute a similar npm script.
- For package changes, validate clean installs and `npm ci`; pin floating optional
  platform dependency ranges when lockfile resolution is nondeterministic.
- Do not package from a worktree with symlinked `node_modules`; treat unresolved
  `@undefined` dependency warnings as packaging failures.
- When splitting work, assign shared files to one owner, sequence hard type
  dependencies, and remove worktrees before repo-wide coverage scans.
- Use `Closes #N`/`Fixes #N`/`Resolves #N` directly in PR bodies and verify issue state
  after merge. Quote backtick-containing GitHub bodies safely and re-fetch them.
- Check `git status`/`git log` after interrupted work, and compare branches with
  read-only `git diff`; never use a repo-wide `git checkout <branch> -- .`.
- 2026-08-11: A lockstep dependency bump (`npm ci` + `npm run check` green) is not
  proof of compatibility if the two updated packages disagree on a shared on-disk
  format they both claim to support (here: `pi-coding-agent@0.84.1` writes session
  JSONL v3, `pi-agent-core@0.84.1` requires v4). Root-cause by reading each
  package's own compiled constants/source before rewriting call sites; the correct
  fix was routing all reads through the same library that already owns writing,
  not reconciling two disagreeing libraries.
- 2026-08-11: A duration/behavior breach in `make test` naming a file no branch
  touched is not automatically a regression, but is not automatically flake
  either — isolate the single file, then re-run the full suite once cleanly
  before concluding either way.
- 2026-08-11: When a merged test asserts an exact array/length against a real
  (non-mocked) production registry, verify what the production function
  actually, intentionally returns (e.g. a full catalog with per-entry
  `configured` flags, not a pre-filtered list) before assuming the assertion —
  not the code — is correct.
- 2026-08-11: After fixing a typecheck error found by `make lint`, re-run
  `git status --short` before considering the branch clean; a verified fix that
  was never `git add`/committed is invisible to the next validation pass and
  will resurface as a false regression later.
- 2026-08-11: A model's status glyph is not simply "configured y/n" — this
  app's Tier 1 credential-state glyphs (`○` missing, `◌` free/keyless, `◐`
  OAuth resolved, `⚿` OAuth session expired) mean different things; read
  `modelStatus()`'s own tests before interpreting a picker glyph as a bug.
- 2026-08-11: A real E2E failure against one specific provider/model (here,
  Anthropic-route models via OpenRouter rejecting a `cache_control` tool
  field) does not block a PR whose own changes are unrelated to that request
  path — isolate by trying a different model/provider first; if the
  alternate path succeeds end-to-end, file the specific failure as a separate
  follow-up instead of treating it as a regression in the change under review.

## Archived incident narratives

The detailed incident records that motivated these rules are archived here:

- [UI and packaged-app lessons](docs/lessons/2026-08-11-agents-ui-and-packaging.md)
- [Parallel-workflow and release lessons](docs/lessons/2026-08-11-agents-operational-lessons.md)

These archives retain historical evidence and reproduction details; this file is
the concise operational reference.
