<div align="center">

<img src="assets/icon.png" width="96" height="96" alt="Pi Desktop icon" />

# Pi Desktop

**A native, secure desktop chat client for any OpenAI-compatible LLM.**

[![CI](https://github.com/tbrandenburg/pi-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/tbrandenburg/pi-desktop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tbrandenburg/pi-desktop)](https://github.com/tbrandenburg/pi-desktop/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](.nvmrc)
[![Electron](https://img.shields.io/badge/electron-43-9feaf9?logo=electron&logoColor=black)](package.json)

[Getting Started](#getting-started) •
[Features](#features) •
[Architecture](#architecture) •
[Scripts](#scripts) •
[Releases](https://github.com/tbrandenburg/pi-desktop/releases)

</div>

---

Pi Desktop streams responses from any OpenAI-compatible provider (OpenAI,
OpenRouter, or a custom gateway) through
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai),
wrapped in a fast, native-feeling Electron + React UI: session history,
model picker, streaming Markdown with syntax-highlighted code, and one-click
cancel.

It ships with a strict security boundary — the renderer never touches Node
or provider APIs directly, and credentials never leave the main process.

## Features

- **Stream from any OpenAI-compatible endpoint** — OpenAI, OpenRouter, or
  your own `openai-completions`-compatible gateway.
- **Zero-config first launch** — if you already have a
  [Pi CLI](https://github.com/earendil-works) config at `~/.pi/agent`, Pi
  Desktop resolves a working provider and model automatically. No API key
  entry required to start chatting.
- **Session history that survives restarts** — every conversation persists
  locally and reopens with the exact model it was run with.
- **Secure by design** — `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer talks to Node only through a narrow, typed
  preload bridge; a saved API key is never sent back to the UI.
- **Cross-platform packaging** — Linux AppImage today; Windows NSIS +
  portable exe verified to build natively.

## Getting started

```bash
npm install
npm run dev     # renderer (Vite) + main (tsc -w) + Electron, hot-reloading
```

On first launch, open **Settings** to configure a provider API key, base
URL, and model — unless you already have a `~/.pi/agent` config, in which
case a working default is picked automatically.

> Prefer `make`? `make install && make run` does the same thing — see
> [Scripts](#scripts) for the full command surface.

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

The renderer speaks only to `window.desktopApi`
(`src/preload/api-types.ts`) — there is no path from the UI to Node, the
filesystem, or provider credentials.

See [`docs/INITIAL.md`](docs/INITIAL.md) for the original design brief and
[`STATUS.md`](STATUS.md) for a running log of milestones, bugs found and
fixed, and verification evidence.

## Scripts

| Command | Description |
| --- | --- |
| `make install` | Install dependencies (`npm install`) |
| `make run` / `make stop` | Start / stop dev mode (Vite + main + Electron) |
| `make test` | Run unit tests (`vitest`) |
| `make lint` / `make check` | Type-check renderer + main (`tsc --noEmit`) |
| `make build` | Build renderer + main for production |
| `make pack` | Build + package app dir only, no installer |
| `make dist-linux` | Build + package the Linux AppImage |
| `make dist-win` | Build + package Windows NSIS + portable installers |
| `make clean` | Remove all build artifacts and `node_modules` |

Run `make help` for the full, always-up-to-date list, including
`run-bundled`/`run-linux`/`run-win` and the `version-*`/`release-*`/
`publish` release workflow.

<details>
<summary>Equivalent plain npm scripts</summary>

```bash
npm run check       # tsc --noEmit for both renderer and main
npm test            # vitest unit/integration tests
npm run build        # build renderer + main for production
npm run dist:linux   # package a Linux AppImage (release/)
```

</details>

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
</content>
