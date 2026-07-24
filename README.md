# Pi Desktop

A polished Electron + React desktop chat app that streams responses from
OpenAI-compatible LLM providers via [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

Built as an overnight demo project: a native-feeling chat UI (sidebar with
session history, model picker, streaming Markdown + syntax-highlighted code,
stop/cancel generation) backed by a small, typed Electron main process that
owns all provider credentials and networking — the React renderer never
touches Node or provider APIs directly.

## Highlights

- **Streaming chat** through any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, or any custom `openai-completions`-compatible gateway).
- **Zero-config first launch**: if you already have a
  [Pi CLI](https://github.com/earendil-works) config at `~/.pi/agent`
  (`settings.json` / `auth.json` / `models.json`), the app resolves a
  working default provider and model from it automatically — no manual API
  key entry required to start chatting.
- **Session browsing and recovery**: past conversations persist locally
  (`electron-store`) and can be reopened, restoring both messages and the
  model that was used.
- **Secure-by-design IPC boundary**: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. The renderer only ever talks to
  the main process through a narrow, typed preload bridge
  (`src/preload/api-types.ts`); the stored API key is never sent back to the
  renderer after saving.
- **Packaged for Linux and Windows** via `electron-builder` (AppImage;
  NSIS installer + portable exe).

## Architecture

```text
src/
├── main/          Electron main process (owns Pi, credentials, IPC, storage)
│   ├── llm/       ChatService (streaming), pi-config.ts (.pi/agent resolution)
│   └── storage/   electron-store wrappers (settings, sessions)
├── preload/       Narrow, typed IPC bridge exposed to the renderer
├── renderer/      React + Zustand UI (never imports Node or Pi APIs)
└── shared/        Types and Zod schemas shared across processes
```

See [`docs/INITIAL.md`](docs/INITIAL.md) for the original design brief and
[`STATUS.md`](STATUS.md) for a running log of completed milestones, bugs
found and fixed, and verification evidence.

## Getting started

```bash
npm install
npm run dev     # renderer (Vite) + main (tsc -w) + Electron, hot-reloading
```

On first launch, open **Settings** to configure a provider API key, base URL,
and model — unless you already have a `~/.pi/agent` config, in which case a
working default is picked automatically.

## Scripts

```bash
npm run check       # tsc --noEmit for both renderer and main
npm test            # vitest unit/integration tests
npm run build        # build renderer + main for production
npm run dist:linux   # package a Linux AppImage (release/)
```

Or via `make` (run `make help` for the full, current list):

```bash
make install         # npm install
make run             # dev mode: renderer (Vite) + main (tsc -w) + Electron
make stop            # kill any running dev/electron processes
make test            # vitest
make lint            # tsc --noEmit (alias: make check)
make build           # build renderer + main for production
make pack            # package app dir, no installer (fast local check)
make dist            # package installers for the current host platform
make dist-linux      # package the Linux AppImage
make dist-win        # package the Windows installer + portable exe
                      # (cross-building from Linux/macOS requires 'wine')
make clean           # remove build artifacts (dist-*, release, node_modules)
```

### Running the bundled (packaged) app

Best-effort convenience targets that run whatever was already built under
`release/` — they never build anything themselves, so run `make dist-linux`
/ `make dist-win` first:

```bash
make run-bundled     # auto-detects the host platform (Linux or Windows)
make run-linux       # run the built .AppImage directly
make run-win         # run the built Windows app: native .exe if already on
                      # Windows, otherwise via 'wine' (best-effort)
```

### Versioning & releases

```bash
make version-patch   # bump 0.1.0 -> 0.1.1: runs check+test, then commits
make version-minor   # bump 0.1.0 -> 0.2.0    "chore(release): vX.Y.Z" and
make version-major   # bump 0.1.0 -> 1.0.0    tags it (all local, no push)
make release         # push the release commit + tag to origin
make publish         # create the GitHub release for the current tag
                      # (release notes only; no build artifacts attached)
make release-patch   # one-shot: bump -> push -> publish
make release-minor
make release-major
```

## Testing the packaged app

Unit tests and `npm run dev` both run through Vite/Node module resolution
directly and do **not** exercise the real compiled/packaged artifact. Before
trusting a fix, build and launch the real thing:

```bash
make dist-linux
make run-linux   # or: release/linux-unpacked/pi-desktop, or the .AppImage directly
```

See [`AGENTS.md`](AGENTS.md) for detailed guidance on testing the packaged
app and lessons learned while building this project.

## License

[MIT](LICENSE)
