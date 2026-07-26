# ADR 0001: Adopt pi-coding-agent's AgentSession as pi-desktop's Agent-Runtime Foundation (staged rollout for the pi-package extension ecosystem)

- **Status:** Proposed
- **Date:** 2026-07-26
- **Deciders:** pi-desktop maintainers
- **Supersedes:** — (this replaces an earlier draft of ADR 0001 that proposed a
  tool-only, pi-agent-core-native mechanism; that approach is recorded and
  rejected in §5, Alternative 1.)
- **Related:** `AGENTS.md` "Architecture rules", STATUS.md Milestones 4/6, issue
  #41 (agent-harness integration).

---

## 1. Context

### 1.1 What pi-desktop is

pi-desktop is an Electron + React + Vite chat app powered by Pi's libraries. All
LLM/agent logic runs in the Electron **main** process and is exposed to the
sandboxed React **renderer** only through a typed preload bridge. The renderer
must never import Node or Pi APIs (`AGENTS.md` rule #4).

Today it depends on:

```jsonc
// package.json (excerpt)
"dependencies": {
  "@earendil-works/pi-agent-core": "^0.81.1", //  agent loop, tools, sessions
  "@earendil-works/pi-ai": "^0.81.1"          //  unified multi-provider LLM API
}
```

The agent turn is a thin wrapper around `pi-agent-core`'s `AgentHarness` in
`src/main/agent/runtime.ts` (147 lines). Tools are hand-written and hard-coded:

```ts
// src/main/agent/tools/index.ts
export function createReadOnlyTools(env: ExecutionEnv) {
  return [createReadFileTool(env), createListFilesTool(env)];
}
```

```ts
// src/main/agent/runtime.ts  (inside AgentRuntime.run)
const harness = new AgentHarness({ env, session, models, model,
  tools: createReadOnlyTools(env), // <-- the only extensibility point today
});
const unsubscribe = harness.subscribe((event) => { /* forward to IPC */ });
await harness.prompt(lastUserMessage.content);
```

There is **no** mechanism for third parties (or us at build time) to add tools,
skills, commands, providers, or lifecycle behavior.

### 1.2 Goal

Give pi-desktop the **same installable extension ecosystem the `pi` CLI has** —
npm packages tagged `pi-package` (e.g. `pi-subagents`, `@zigai/pi-*`,
`pi-web-agent`, `pi-plan-mode`) — for both:

1. **Build-time** extension (curated packages baked into the portable binary,
   zero network/toolchain needed), and
2. **Runtime** extension (user installs more later).

### 1.3 Where the extension mechanism lives (and its cost)

The `pi-package` system is owned entirely by a **third** package,
`@earendil-works/pi-coding-agent` (the package that ships the `pi` binary). It is
**not** in `pi-agent-core` or `pi-ai`. `pi-coding-agent` re-exports the extension
machinery as headless primitives (`DefaultPackageManager`,
`discoverAndLoadExtensions`, `ExtensionRunner`, `createAgentSession`, …).
Cost/benefit vs. `pi-agent-core` (facts verified against the `0.82.1` tarballs):

| | `pi-agent-core` (have) | `pi-coding-agent` (candidate) |
|---|---|---|
| Unpacked size | 1.7 MB | 15 MB (~9x) |
| Nature | Library (agent loop, harness, sessions) | Full CLI app (TUI, RPC/JSON/print, themes, keybindings) — extension system is a byproduct |
| Owns `pi-package` ecosystem? | **No** — no manifest, no discovery, no `registerTool`/hooks | **Yes** — the only owner |
| Session model | `Session`/`JsonlSessionRepo` (what we use today) | Its own `SessionManager` |
| Model layer | `MutableModels` (pi-ai) (what we build today) | Its own `ModelRuntime` |

### 1.4 Compatibility measurement (the decisive data)

We downloaded and statically analyzed **60 real `pi-package`-keyword npm
packages** (a representative sample of a ~250+ package ecosystem), classifying
each package's actual `ExtensionAPI` usage (distinguishing genuine pi extensions
from MCP servers and from Node stream `.on()` false positives).

Of the **43** that are genuine pi *code* extensions:

| Category | Count | Share of pi extensions |
|---|---|---|
| Tool-only (`registerTool`, nothing else) | 1 | **~2%** |
| Skills/prompts-only (no code API) | 1 | ~2% |
| **Uses hooks / commands / UI / providers** | **41** | **~95%** |

Blocking-API frequency among the incompatible 41:

| API | % of incompatible pkgs |
|---|---|
| `pi.on(...)` lifecycle hooks | 93% |
| `ctx.ui.*` (dialogs/widgets) | 80% |
| `registerCommand` (slash commands) | 76% |
| `sendMessage`/`setModel`/… | 49% |
| `setActiveTools` | 33% |
| `registerFlag`/`registerShortcut` | ~15% each |
| `registerProvider` | 13% |

(Also notable: **~23%** of `pi-package` search hits are actually **MCP servers**,
not pi extensions — see §6 for the parallel opportunity that implies.)

**Conclusion:** the ecosystem is overwhelmingly built on hooks, slash commands,
and interactive UI. A tool-only mechanism buys ~2% reuse — effectively nothing.
Real ecosystem reuse *requires* the full `ExtensionRunner` surface, which only
`pi-coding-agent` provides. There is no cheaper substitute; that surface **is**
the value.

### 1.5 Why "big" can nonetheless "start small" — the enabling discovery

The expensive-sounding part ("stand up `pi-coding-agent`'s `SessionManager` +
`ModelRuntime` alongside or instead of ours") is largely solved by using
`pi-coding-agent`'s **own high-level entry point**, verified at `0.82.1`:

- `createAgentSession(options?)` — **every option is optional**
  (`dist/core/sdk.d.ts`): `cwd` defaults to `process.cwd()`; `sessionManager`,
  `settingsManager`, `modelRuntime` all default. It returns
  `{ session: AgentSession, extensionsResult }`. So we do **not** hand-build the
  session/model abstractions — the factory does.
- `AgentSession` is **interface-compatible** with `AgentHarness`
  (`dist/core/agent-session.d.ts`): it exposes `prompt(text, options?)`,
  `subscribe(listener)`, `abort()` — the exact three calls `runtime.ts` already
  makes on `AgentHarness`.
- `AgentSessionEvent` is a **superset** of the events `runtime.ts` already
  forwards (`message_update`, `tool_execution_start`, `agent_end` — the latter
  still carries `messages[]`). The `forward()` mapping in `runtime.ts` largely
  survives.
- The real `ExtensionRunner` lives **inside** `AgentSession`, wired via
  `runner.setUIContext(uiContext, mode)` internally
  (`dist/core/agent-session.js:1805`). We get the full extension host for free by
  using the session, and `hasUI=false` cleanly no-ops the UI half until Phase 2.
- pi-desktop's own stored API key/base URL can be injected without touching
  `~/.pi/agent/auth.json`: `ModelRuntime` supports
  `setRuntimeApiKey(providerId, apiKey)` and `ModelRuntimeAuthOverrides.apiKey`
  (`dist/core/model-runtime.d.ts`).

So the migration's blast radius is contained to `src/main/agent/**` and the model
loaders — both already isolated behind injectable loaders — because
`AgentSession` slots into the same three-method seam `AgentHarness` occupies.

---

## 2. Decision

**Adopt `@earendil-works/pi-coding-agent` and replace pi-desktop's thin
`AgentHarness` wrapper with its `AgentSession` (via `createAgentSession`) as the
agent-runtime foundation. Keep the *full* extension contract; stage the rollout
by which extension *capabilities* are surfaced, not by shrinking the contract.**

Concretely:

1. Add `@earendil-works/pi-coding-agent` as a main-process-only dependency
   (imported only from `src/main/agent/**`), version-locked to the same `0.x`
   line as `pi-ai`/`pi-agent-core` (all `0.82.x` today). `pi-agent-core` remains
   present as its transitive dependency.
2. Rebuild `AgentRuntime` (`src/main/agent/runtime.ts`) on `createAgentSession` +
   `AgentSession.prompt/subscribe/abort`, reusing the existing event→IPC mapping.
3. Inject pi-desktop's stored provider credentials into `ModelRuntime`
   (`setRuntimeApiKey` / auth overrides) so settings still round-trip through
   main only (`AGENTS.md` rule #5), never `~/.pi/agent`.
4. Point extension discovery at bundled package paths (Phase 1) and, later,
   user-installed paths (Phase 3), through `DefaultPackageManager` /
   the resource loader.
5. Roll out capabilities in phases (§3.4). Phase 1 runs headless
   (`hasUI=false`); the **real** `ExtensionRunner` is present from day one, so
   nothing built is throwaway.

This is an architecture change to `AGENTS.md` rule #1 ("do not change the
architecture … + pi-ai (+ optional pi-agent-core)") — it adds `pi-coding-agent`
as a foundation — which is exactly why it requires this ADR. It does **not**
violate rule #2 (no Tauri/Rust/Next.js/separate process — this is an in-process
library), #4 (renderer isolation), or #5 (keys stay in main).

---

## 3. Detailed design

### 3.1 Packaging trap (must-read; reuse existing solution)

`pi-coding-agent` is ESM-only with subpath `exports` — the identical trap already
documented and solved for `pi-ai`/`pi-agent-core` in `src/main/native-import.ts`:

> Under `tsconfig.main.json`'s `"module": "CommonJS"`, `tsc` silently downlevels
> `await import(x)` into `require(x)`, which throws **only in the packaged
> AppImage** (never in unit tests or `npm run dev`).

Every `pi-coding-agent` import must go through the existing helper, behind an
injectable loader mirroring `AgentCoreLoaders` (`src/main/agent/core.ts`):

```ts
// src/main/agent/core.ts  (existing pattern to copy)
export const nativeDynamicImport = new Function("s", "return import(s);"); // native-import.ts
// tests inject a static-import fixture; see test-support/real-agent-core-loaders.ts
```

New `CodingAgentLoaders` loads `createAgentSession`, `DefaultPackageManager`,
`ModelRuntime`, etc. Because `nativeDynamicImport` is invisible to `vi.mock` and
Vitest's vm pool cannot run `new Function()`-built dynamic imports
(`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), tests inject a fixture importing the
package statically — the established pattern
(`src/main/agent/test-support/real-agent-core-loaders.ts`,
`src/main/model/test-support/real-models-loaders.ts`). Add subpath
`declare module` shims if needed (mirrors `agent-core-subpaths.d.ts`).

**Also new and specific to this dependency:** extensions are loaded via `jiti`
(pi-coding-agent transpiles `.ts` extensions at load). Its behavior inside the
packaged `asar` layout is unproven and **must** be validated against the real
AppImage (see §4.2).

### 3.2 The new runtime (replacing AgentHarness)

```ts
// src/main/agent/runtime.ts  (rewritten — illustrative)
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders } from "./coding-agent-loaders";

export class AgentRuntime {
  constructor(private readonly loaders: CodingAgentLoaders = {}) {}

  async run({ requestId, request, cwd, settings, model, signal, emit }: AgentRuntimeRunArgs) {
    const { createAgentSession, ModelRuntime } = await loadCodingAgent(this.loaders);

    // Inject pi-desktop's own stored credential — never ~/.pi/agent/auth.json.
    const modelRuntime = await ModelRuntime.create(/* pi-desktop paths / no network */);
    await modelRuntime.setRuntimeApiKey(model.provider, settings.apiKey);

    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      // Phase 1: only bundled tool/skill extensions are on the discovery path.
      // customTools: [...our builtin read-only tools mapped to ToolDefinition],
    });

    const unsubscribe = session.subscribe((event) => this.forward(requestId, event, emit));
    if (signal.aborted) void session.abort();
    else signal.addEventListener("abort", () => void session.abort(), { once: true });

    emit({ type: "started", requestId });
    try {
      await session.prompt(lastUserMessageContent);
      emit({ type: "completed", requestId });
    } catch (e) {
      emit({ type: "error", requestId, message: e instanceof Error ? e.message : String(e) });
    } finally { unsubscribe(); }
  }

  private forward(requestId: string, event: AgentSessionEvent, emit: (e: ChatEvent) => void) {
    // Same shape as today's runtime.ts: message_update -> text/reasoning delta,
    // tool_execution_start -> tool-call, agent_end -> usage.
  }
}
```

`ChatService` (`src/main/chat/service.ts`) already delegates to
`AgentRuntime.run` and passes `settings`, `model`, `cwd`, `emit`, `signal`; its
shape is preserved. The current `buildModelsRegistry`/`findModelById` model
resolution in `src/main/model/registry.ts` is refactored to resolve a `Model`
from `ModelRuntime` (or kept as the pre-resolution step feeding
`createAgentSession({ model })`).

### 3.3 Built-in tools

The existing read-only tools (`createReadOnlyTools`) are preserved as
`customTools` on `createAgentSession` (converted to pi-coding-agent's
`ToolDefinition` — a thin adapter, same `parameters`/`execute` shape). Extension
tools are additive on top.

### 3.4 Staged rollout (the "start small")

The stages gate which **capabilities are surfaced**, not the contract. The real
`ExtensionRunner` is present in Phase 1, so each phase is additive.

| Phase | Ships | Ecosystem unlocked | New cost |
|---|---|---|---|
| **1 — Runtime swap, headless** | `AgentHarness` → `AgentSession`; real `ExtensionRunner`; `hasUI=false`; load bundled tool/skill extensions only; commands/hooks *load* but UI calls no-op | Tool-only pkgs (~2%) **on the real runner** — plus a proven foundation | Runtime rewrite (contained); ESM/CJS + jiti-in-asar revalidation; +~13 MB packaged |
| **2 — UI bridge** | `ExtensionUIContext` (`select`/`confirm`/`input`/`notify`) over IPC → React modals; surface slash-commands in the composer | **~80%** (`ctx.ui`) + **~76%** (`registerCommand`) — the big jump | IPC + React modal adapter (genuine glue) |
| **3 — Providers + runtime install** | `registerProvider` bridge; `DefaultPackageManager` over IPC for user installs; **trust/consent gate** | Provider-based + user-installable packages | Provider wiring; portable-exe npm degradation; security gate |

TUI-only APIs (`custom()`, `setWidget`, `setFooter`, `setEditorComponent` — they
return `@earendil-works/pi-tui` `Component`s) are **never** implemented; they stay
no-ops. This is the same split pi already draws between `mode: "tui"` and
`"rpc"/"json"/"print"`. pi-desktop is effectively a new "electron" mode of the
existing UI-optional contract.

### 3.5 Build-time extension (portable binary)

Curated packages ship as **local-path** sources, pre-transpiled to `.js` at our
build time (so no runtime jiti/npm needed for bundled ones):

```yaml
# electron-builder.yml
extraResources:
  - from: resources/pi-packages
    to: pi-packages
```

At startup, `process.resourcesPath/pi-packages/*` feed the extension discovery
path. No network, no toolchain — satisfies the portable-exe constraint. Peer
deps (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `typebox`) are provided by the
host, not bundled per-package (the ecosystem's `peerDependencies: "*"`
convention). `pi-tui` is only needed by TUI extensions, which we run headless —
so we do not ship it and reject/skip TUI-only extensions.

### 3.6 Runtime extension (user installs later)

Expose `DefaultPackageManager` over IPC via the `AGENTS.md` three-file recipe
(domain-named channels `packages:list|install|remove|update`), backed by a
desktop-owned settings/install location under Electron `userData` (never the
user's global `~/.pi/agent`, never next to the portable exe). Update
`src/renderer/lib/fake-desktop-api.ts` so the browser harness keeps compiling
(`AGENTS.md` lesson #14).

Portable-exe caveat: npm-source install needs a network + writable dir + npm
(via the `npmCommand` settings override or a bundled npm). Degradation ladder:
local-path & git only → bundled npm → full npm on installers with system Node.

### 3.7 Security / trust (non-negotiable before Phase 3)

`pi-coding-agent`'s `docs/packages.md`: *"Pi packages run with full system
access. Extensions execute arbitrary code."* In a distributed desktop binary this
is a larger liability than in a CLI. Before **runtime** third-party install
ships: an explicit consent/trust gate (reuse pi's `ProjectTrustStore`), plus a
Settings-dialog listing of installed packages + source + remove. Build-time
curated bundles are vetted by us but still listed.

---

## 4. Consequences

### 4.1 Positive

- **Real ecosystem reuse.** Phase 1 lays the foundation; Phase 2 unlocks ~80% of
  the ecosystem (the hook/command/UI packages the data shows dominate); Phase 3
  the rest. This is the only path that reaches the 95% the tool-only approach
  abandoned.
- **Not throwaway.** The real `ExtensionRunner`/`AgentSession` is used from Phase
  1; later phases are additive UI/provider wiring, not rewrites.
- **Contained migration.** `AgentSession` slots into the same three-method seam
  (`prompt`/`subscribe`/`abort`) as `AgentHarness`; events are a superset. Blast
  radius stays in `src/main/agent/**` + model loaders.
- **Both extension modes satisfied** (build-time bundles, runtime installs).
- **Credentials stay in main** via `ModelRuntime.setRuntimeApiKey` (rule #5 intact).

### 4.2 Negative / risks

- **Dependency weight:** +~13 MB unpacked; pulls in TUI/themes/RPC we don't use.
  Accept the packaged-size increase; import only from `src/main/agent/**`.
- **Replaces the Milestone 4 / #41 runtime.** The `pi-agent-core` `AgentHarness`
  path is superseded. Mitigated by interface-compatibility, but it is a real
  rewrite that must re-pass all agent tests + packaged validation.
- **ESM/CJS packaging trap + jiti-in-asar** (§3.1): invisible to `npm test` and
  `npm run dev`; only manifests in the packaged AppImage. **Mandatory:** validate
  against the real artifact per `AGENTS.md` "Diagnosing bugs that only reproduce
  in the packaged app" — end-to-end via `scripts/cdp-drive.ts`.
- **Version lockstep:** `pi-coding-agent`/`pi-ai`/`pi-agent-core` must move
  together (shared `0.x` line). Bumps are coordinated + re-validated.
- **Arbitrary code execution** (§3.7): Phase 3 must not ship without the trust
  gate.

### 4.3 Neutral

- `createReadOnlyTools` survives as `customTools`.
- `AGENTS.md` rule #1 wording updated to name `pi-coding-agent` as the runtime
  foundation.

---

## 5. Alternatives considered

1. **Tool-only, pi-agent-core-native mechanism (the earlier ADR 0001 draft).**
   Rejected: the compatibility data (§1.4) shows it reaches only ~2% of pi
   extensions because 95% need hooks/commands/UI. It optimizes the wrong axis —
   minimizing the dependency by crippling the contract — and its bespoke loader
   would be largely thrown away once real ecosystem reuse is needed. Its one
   lasting idea (bundling curated packages as local paths) is preserved here in
   §3.5.
2. **Keep hand-writing tools (status quo).** Rejected: no ecosystem, no
   build-time or runtime extensibility.
3. **Run the real `pi` CLI as a subprocess over `--mode rpc`.** Rejected:
   violates rule #2 (no separate process) and complicates the portable
   single-binary story; embedding in-process is simpler and keeps everything in
   main.
4. **Adopt everything at once (all phases in one shot).** Rejected: unnecessarily
   risky. The staged rollout (§3.4) ships a validated foundation first and adds
   the UI/provider surface incrementally, each phase independently testable.

---

## 6. Parallel opportunity: MCP bridge (out of scope, noted)

~23% of `pi-package` search hits are actually **MCP servers**, not pi extensions.
A generic **MCP client bridge** in pi-desktop would unlock those independently of
this extension mechanism, and may be higher-ROI per unit effort for pure-tool
capabilities (web search, etc.). It is intentionally **out of scope** for this
ADR and should be evaluated as its own decision — but the data means "add MCP
support" and "adopt pi extensions" are two distinct, non-overlapping levers.

---

## 7. Implementation checklist (phased)

**Phase 0 — decision**
- [ ] Accept this ADR; update `AGENTS.md` rule #1 to name `pi-coding-agent` as
      the main-process-only runtime foundation.

**Phase 1 — runtime swap, headless**
- [ ] Add `@earendil-works/pi-coding-agent` (`^0.82.x`; bump `pi-ai`/
      `pi-agent-core` to the same line).
- [ ] `src/main/agent/coding-agent-loaders.ts` (`CodingAgentLoaders`) +
      `test-support` static-import fixture + subpath shims if needed.
- [ ] Rewrite `AgentRuntime` on `createAgentSession` /
      `AgentSession.prompt/subscribe/abort`; reuse the event→IPC mapping.
- [ ] Inject pi-desktop's stored credential via `ModelRuntime.setRuntimeApiKey`;
      keep model resolution in `src/main/model/registry.ts` feeding
      `createAgentSession({ model })`.
- [ ] Port `createReadOnlyTools` to `customTools`.
- [ ] Bundle 1 curated tool-only package under `resources/pi-packages/` +
      `electron-builder.yml` `extraResources`.
- [ ] Unit tests (injected fake loaders + real fixture). **Package the AppImage
      and prove: (a) a normal chat turn still works, (b) a bundled extension tool
      actually runs, (c) jiti loads inside asar — all end-to-end via
      `scripts/cdp-drive.ts`.**

**Phase 2 — UI bridge (unlocks the ~80%)**
- [ ] `ExtensionUIContext` adapter (`select`/`confirm`/`input`/`notify`) over IPC
      → React modals; set `hasUI=true`, `mode="rpc"`.
- [ ] Surface `registerCommand` slash-commands in the composer.
- [ ] Re-validate against the packaged artifact.

**Phase 3 — providers, runtime install, trust**
- [ ] `packages:*` IPC (three-file recipe) + fake-desktop-api update.
- [ ] Desktop-owned settings/install dir under `userData`.
- [ ] `registerProvider` bridge.
- [ ] Trust/consent gate before executing third-party extensions; Settings-dialog
      package list.
- [ ] Portable-exe install degradation (local/git-only or bundled npm).
- [ ] Re-validate against the packaged artifact.

---

## 8. References

- `@earendil-works/pi-coding-agent@0.82.1`: `dist/core/sdk.d.ts`
  (`createAgentSession`, `CreateAgentSessionOptions`, `CreateAgentSessionResult`),
  `dist/core/agent-session.d.ts` (`AgentSession.prompt/subscribe/abort`,
  `AgentSessionEvent`), `dist/core/agent-session.js:1805` (`setUIContext`),
  `dist/core/agent-session-services.d.ts` (`createAgentSessionServices`),
  `dist/core/model-runtime.d.ts` (`ModelRuntime.setRuntimeApiKey`,
  `ModelRuntimeAuthOverrides`), `dist/core/package-manager.d.ts`
  (`DefaultPackageManager`), `dist/core/extensions/runner.d.ts` (`ExtensionRunner`,
  `setUIContext`, `hasUI`), `docs/extensions.md`, `docs/packages.md`.
- Compatibility measurement: static analysis of 60 `pi-package`-keyword npm
  packages (2026-07-26); 43 genuine pi code extensions, of which ~2% tool-only,
  ~95% use hooks/commands/UI/providers; ~23% of hits were MCP servers.
- pi-desktop: `src/main/agent/runtime.ts` (harness seam, injectable loaders at
  line 62), `src/main/agent/core.ts` (`AgentCoreLoaders`),
  `src/main/agent/tools/index.ts`, `src/main/agent/tools/read-file.ts`,
  `src/main/native-import.ts`, `src/main/model/registry.ts`,
  `src/main/chat/service.ts`, `src/main/settings/store.ts`, `src/shared/events.ts`,
  `src/preload/index.ts`, `src/main/ipc.ts`,
  `src/renderer/lib/fake-desktop-api.ts`,
  `src/main/agent/test-support/real-agent-core-loaders.ts`,
  `electron-builder.yml`, `scripts/cdp-drive.ts`.
- `AGENTS.md` — "Architecture rules", "How to add X (Adding an IPC channel)",
  "Diagnosing bugs that only reproduce in the packaged app", lessons #1–#14.
- STATUS.md — Milestones 4 (streaming chat) and 6 (sessions).
