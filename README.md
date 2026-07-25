<div align="center">

<img src="assets/icon.png" width="96" height="96" alt="Pi Desktop icon" />

# Pi Desktop

**A portable AI agent desktop app for everyone — no vendor lock-in, no dev tools required.**

[![CI](https://github.com/tbrandenburg/pi-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/tbrandenburg/pi-desktop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tbrandenburg/pi-desktop)](https://github.com/tbrandenburg/pi-desktop/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](.nvmrc)
[![Electron](https://img.shields.io/badge/electron-43-9feaf9?logo=electron&logoColor=black)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting Started](#getting-started) •
[Features](#features) •
[Configuration](#configuration) •
[Philosophy](#philosophy) •
[Architecture](#architecture) •
[Scripts](#scripts) •
[Contributing](#contributing) •
[Releases](https://github.com/tbrandenburg/pi-desktop/releases)

</div>

---

> [!NOTE]
> 🧪 **Young project, moving fast.** Pi Desktop is under active, early-stage
> development — expect rough edges and breaking changes between releases
> while things settle. We're optimistic about where this is headed (and
> having a lot of geeky fun building it) — feedback and issues are very
> welcome, just don't wire it into anything mission-critical yet.

Pi Desktop is a downloadable, double-click desktop app that runs a real
**agent** — not just a chat box — on top of
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
and [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core):
a native-feeling Electron + React UI with session history, model picker,
streaming Markdown with syntax-highlighted code, and one-click cancel.

Because it's built on `pi-ai`, there is **no vendor lock-in**: it ships with
[38 built-in provider catalogs](https://www.npmjs.com/package/@earendil-works/pi-ai)
(OpenAI, Anthropic, Google Gemini, OpenRouter, GitHub Copilot, Cerebras,
Fireworks, and more) plus any custom OpenAI-compatible gateway — pick a model,
not a vendor.

It ships with a strict security boundary — the renderer never touches Node
or provider APIs directly, and credentials never leave the main process.

<div align="center">
<img src="assets/screenshot.png" alt="Pi Desktop: streaming chat with syntax-highlighted code" width="720" />
</div>

## Features

- **Any model, any provider — no lock-in.** Powered by `pi-ai`'s 38
  built-in provider catalogs (OpenAI, Anthropic, Google Gemini, OpenRouter,
  GitHub Copilot, Cerebras, Fireworks, and more), or bring your own
  OpenAI-compatible endpoint. Credentials from an existing
  [Pi CLI](https://github.com/earendil-works/pi) `~/.pi/agent/auth.json` are
  picked up automatically.
- **A real agent, not just chat.** Every turn runs through
  `pi-agent-core`'s `AgentHarness` — a genuine tool-calling loop (not a
  single request/response) that streams live `tool_execution_*` events to
  the UI. Ships with `read_file` and `list_files` tools out of the box, so
  the agent can actually look at your project instead of guessing.
- **Real, resumable agent sessions.** Each conversation is a cwd-scoped
  `JsonlSessionRepo` session from `pi-agent-core` — persisted to disk as
  plain JSONL, not just app-local key/value storage — so history and tool
  calls survive restarts and reopen with the exact model used.
- **Zero-config first launch** — if you already have a Pi CLI config at
  `~/.pi/agent`, Pi Desktop resolves a working provider and model
  automatically. No manual API key entry required to start chatting.
- **Secure by design** — `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer talks to Node only through a narrow, typed
  preload bridge; a saved API key is never sent back to the UI.
- **Built for everyone, not just developers.** The packaged app is a
  double-click installer/AppImage — running it needs no Node, npm, or
  terminal. Linux (AppImage) and Windows (NSIS installer + portable exe)
  build and package today (`make dist-linux` / `make dist-win`); macOS
  packaging is on the roadmap. Prebuilt binaries aren't attached to
  releases yet, so building locally is currently required.

## Getting started

**Just want to run the app?** Releases don't attach prebuilt binaries yet
(see [Releases](https://github.com/tbrandenburg/pi-desktop/releases)) — for
now, build your own portable installer locally with `make dist-linux` or
`make dist-win` (see [Scripts](#scripts)), no code changes needed.

**Want to build or hack on it?**

```bash
npm install
npm run dev     # renderer (Vite) + main (tsc -w) + Electron, hot-reloading
```

On first launch, open **Settings** to configure a provider API key, base
URL, and model — unless you already have a `~/.pi/agent` config, in which
case a working default is picked automatically.

> Prefer `make`? `make install && make run` does the same thing — see
> [Scripts](#scripts) for the full command surface.

## Configuration

Pi Desktop currently relies on the standard [Pi agent](https://pi.dev)
configuration — see the [Pi documentation](https://pi.dev/docs/latest) for
the full reference on providers, models, and `~/.pi/agent` credentials. If
you already have a working Pi CLI setup, Pi Desktop picks it up
automatically; otherwise, configure a provider API key, base URL, and model
via **Settings**.

> 🚧 **Under development:** built-in, zero-configuration model access
> (bundled providers you can use out of the box, no API key setup required)
> is planned but not shipped yet — for now, basic Pi agent configuration is
> the supported path.

## Architecture

```text
src/
├── main/          Electron main process (owns Pi, credentials, IPC, storage)
│   ├── llm/       AgentRuntime (pi-agent-core AgentHarness + tool loop),
│   │              models.ts (38 built-in provider catalogs via pi-ai),
│   │              tools/ (read_file, list_files), pi-config.ts (.pi/agent)
│   └── storage/   electron-store wrappers (settings, session metadata)
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

## Philosophy

Following the same principle as the [Pi project](https://github.com/earendil-works/pi)
it's built on: a small, deliberately-bounded feature set, made robust and
stable, beats a sprawling one that's merely "done."

- **Two tools, on purpose.** The agent ships with exactly `read_file` and
  `list_files` — no shell, write, or edit tools. Read-only by design keeps
  the trust boundary simple to reason about.
- **One runtime path.** Every chat turn goes through the same
  `pi-agent-core` `AgentHarness` loop — no parallel "simple mode"/"agent
  mode" split to maintain.
- **Grow by hardening, not by adding.** New surface area is added only when
  it's proven necessary and can be tested end-to-end against the real
  packaged app (see [`AGENTS.md`](AGENTS.md)) — not spec'd speculatively.

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

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
dev setup, pre-PR checks, and code/testing guidelines.

## Acknowledgments

Pi Desktop is a thin UI shell around the [Pi project](https://github.com/earendil-works/pi)
(**[`pi.dev`](https://pi.dev)**) — all model access, provider abstraction,
and agent tool-calling in this app come from its `pi-ai` and `pi-agent-core`
packages. All credit for the underlying agent runtime and multi-provider LLM
API goes to the Pi maintainers; this repo only adds the desktop UI, IPC
boundary, and packaging around it.

## License

[MIT](LICENSE)
</content>
