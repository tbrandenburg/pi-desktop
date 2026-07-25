# Contributing to Pi Desktop

Thanks for your interest in improving Pi Desktop. This project favors small,
verifiable changes over large speculative ones.

## Getting set up

```bash
make install   # npm install
make run       # dev mode: Vite renderer + tsc -w main + Electron, hot-reloading
```

Requires Node `>=22.19` (see `.nvmrc` for the exact CI version).

## Before opening a PR

Run the full local check suite — this is exactly what CI runs:

```bash
make check   # tsc --noEmit for renderer + main
make test    # vitest unit/integration tests
```

For changes that touch Electron packaging, IPC, or anything that behaves
differently once compiled, also verify the real packaged app — `npm run dev`
and `vitest` both skip Node/Electron's actual module resolution and asar
packaging, so a change can pass every test and still break the shipped
AppImage:

```bash
make dist-linux
make run-linux
```

See [`AGENTS.md`](AGENTS.md) for the full packaged-app testing procedure and
hard-won lessons from this project's history.

## Code guidelines

- **Architecture stays fixed**: Electron + React + Vite + `pi-ai`. No Tauri,
  no Rust, no separate server process.
- **Keep Pi imports contained**: all `@earendil-works/pi-ai` /
  `@earendil-works/pi-agent-core` usage stays inside `src/main/llm`.
- **The renderer never touches Node or Pi APIs directly** — it only talks to
  the main process through the typed preload bridge
  (`src/preload/api-types.ts`). Don't widen that surface without a good
  reason.
- **No secrets in renderer state** — a saved API key must never be sent back
  to the UI after saving.
- Prefer strict typing (`unknown` over `any`), early returns over
  `else`-chains, and small, focused files.

## Testing guidelines

- Assertions must actually fail if the underlying logic breaks — no
  "didn't throw" placeholders.
- Never derive an expected test value by calling the function under test —
  use a hand-computed or independently-known value.
- Don't mock a dependency unless the mock itself is what's being tested;
  prefer real implementations (see `session-store.test.ts` for the pattern:
  real `electron-store` against a throwaway disk directory, not an in-memory
  fake).
- Clean up anything stateful (timers, listeners, open handles) in
  `afterEach`.

## Commit style

Use concise, conventional-commit-style messages (`feat: …`, `fix: …`,
`docs: …`, `chore: …`). Keep unrelated changes in separate commits/PRs.

## Reporting issues

Open a [GitHub issue](https://github.com/tbrandenburg/pi-desktop/issues) with
steps to reproduce, expected vs. actual behavior, and — for anything
packaging-related — whether you saw it in `npm run dev`, the packaged app, or
both.
