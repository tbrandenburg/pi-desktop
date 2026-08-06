# ADR 0001: Adopt pi-coding-agent's AgentSession as pi-desktop's Agent-Runtime Foundation (staged rollout for the pi-package extension ecosystem)

- **Status:** Accepted (2026-08-05, maintainer approval recorded on issue #77)
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

> **Resolved (2026-08-05 spike, evidence-based):** jiti-in-asar is **not a
> blocker**. A real spike packed `@earendil-works/pi-coding-agent` plus a
> trivial `.ts` extension into a genuine `.asar` archive and loaded it via
> `ELECTRON_RUN_AS_NODE=1 electron` using the repo's existing
> `nativeDynamicImport` trick (`native-import.ts`) — the extension was
> transpiled and loaded successfully directly from the asar virtual path, no
> extraction needed (`result.extensions.length === 1`, `errors: []`).
> Inspection of `dist/core/extensions/loader.js` shows jiti runs with
> `moduleCache: false` (no disk-cache writes against the read-only asar) and
> is inlined into `pi-coding-agent`'s own bundle (no separate `jiti`
> package/native-binary resolution step) — both of the realistic asar traps
> are avoided by construction, not by luck. Recommendation: downgrade this
> from "unproven, must validate" to "validated, low risk"; still re-confirm
> once via a real `electron-builder` AppImage + `scripts/cdp-drive.ts` before
> Phase 1 ships, per the repo's standing "always validate the real artifact"
> rule — but no blocking risk remains for the approval decision itself.

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
| **3 — Providers + runtime install** | `registerProvider` bridge; `DefaultPackageManager` over IPC for user installs; **one-time install consent** | Provider-based + user-installable packages | Provider wiring; portable-exe npm degradation; consent UX |

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

> **Resolved (2026-08-05 spike, evidence-based):** researched and
> source-inspected 16 real `pi-package`-keyword npm packages (8 via direct
> `npm pack` + source read, not just README claims) to name the actual Phase 1
> candidate. Finding: **zero** of the 16 pass a strict "`registerTool` and
> nothing else, zero hooks" reading — this empirically reproduces the ADR's
> own §1.4 statistic (~2%/1-of-43) rather than contradicting it. The closest
> candidate, `pi-deepseek-search@1.0.15`, has exactly one `registerTool` call
> plus a single benign `pi.on("session_start")` re-registration hook, no
> `registerCommand`/`registerProvider`/`ctx.ui.*` — but its `execute()` makes
> an unaudited outbound `fetch()` to a third-party endpoint carrying the
> user's API key, which is real, unreviewed third-party code with full system
> access shipping inside the signed desktop binary (§3.7's warning applies
> directly), and it's provider-locked to DeepSeek only.
>
> **Recommendation: do not bundle a third-party package for Phase 1.** Instead,
> package pi-desktop's **own** existing `createReadOnlyTools` (already noted in
> §3.3 as convertible to `ToolDefinition`s) as a first-party local `pi-package`
> under `resources/pi-packages/`. This proves the build-time
> bundling/`extraResources`/discovery mechanism end-to-end with **zero**
> unaudited third-party code risk, and defers the "bundle a real third-party
> package" milestone until either (a) the ecosystem produces a genuinely
> strict tool-only package, or (b) Phase 2's UI bridge lands and a
> hook/command-using package becomes viable to bundle with a proper review.

### 3.6 Runtime extension (user installs later)

Expose `DefaultPackageManager` over IPC via the `AGENTS.md` three-file recipe
(domain-named channels `packages:list|install|remove|update`), backed by the
real, shared `~/.pi/agent` directory (`getAgentDir()`, same as
models/sessions -- see issue #104) so packages installed via pi-desktop or the
real `pi` CLI/TUI are immediately visible to both. Update
`src/renderer/lib/fake-desktop-api.ts` so the browser harness keeps compiling
(`AGENTS.md` lesson #14).

Portable-exe caveat: npm-source install needs a network + writable dir + npm
(via the `npmCommand` settings override or a bundled npm). Degradation ladder:
local-path & git only → bundled npm → full npm on installers with system Node.

> **Resolved (2026-08-05 spike, evidence-based):** verified Electron ships
> **no npm at all** alongside its bundled Node (`node_modules/electron/dist/`
> contains only the Electron binary/Chromium/V8 resources — `ELECTRON_RUN_AS_NODE`
> reaches Node in-process, not a standalone install with npm next to it), so
> "bundled npm" means vendoring the full npm CLI + its own dependency tree
> ourselves, not a free reuse of something Electron already ships. A
> lighter-weight alternative (fetch a package tarball directly from
> `registry.npmjs.org` + extract, no third-party code) was prototyped and
> broke on the **first** real package tested (`is-odd@3.0.1`, which declares
> a transitive dependency on `is-number@^6.0.0`) — proving a bespoke fetcher
> cannot substitute for real semver-range resolution/hoisting/dedup; it would
> mean reimplementing npm's resolver core, not a small shortcut.
>
> **Recommendation: ship only the first ladder tier — local-path & git —
> for the first Phase 3 release.** It needs zero new vendored dependencies,
> zero registry-availability/rate-limit dependency at runtime, and lets the
> §3.7 install-consent flow be built and validated against the smallest
> possible install surface (a git URL + pinned ref) before ever adding
> npm's much larger arbitrary-code + transitive-dependency attack surface.
> "Full npm on installers with system Node" (ladder tier 3) is moot for now
> anyway, since `AGENTS.md` rule #6 already defers Windows/installer
> packaging. Whether "bundled npm" (tier 2) is ever worth building at all is
> a genuinely open **product** question (real user demand for npm-registry
> `pi-package` installs vs. git-hosted ones) that this research cannot
> settle from the codebase alone — revisit only if real demand surfaces
> after tier 1 ships.
>
> **Superseded (issue #104):** `npm:` sources are now supported, reusing
> `DefaultPackageManager`'s own npm install path as-is (no bespoke fetcher),
> gated by an additional pre-install confirm warning that npm lifecycle
> scripts run immediately, plus the existing §3.7 post-install trust gate.
>
> **Superseded again (issue #109):** the separate npm-specific pre-install
> confirm and the post-install trust gate were collapsed into a single
> pre-install consent prompt shown for every source type (local-path, git,
> `npm:` alike) -- see §3.7 below for the full rationale.

### 3.7 Security / consent (one-time, install-time only)

`pi-coding-agent`'s `docs/packages.md`: *"Pi packages run with full system
access. Extensions execute arbitrary code."* In a distributed desktop binary
this is a larger liability than in a CLI. Runtime third-party install requires
a single, real pre-install consent prompt, plus a Settings-dialog listing of
installed packages + source + remove -- full transparency instead of a
persistent capability gate. Build-time curated bundles are vetted by us but
still listed.

> **Clarified (2026-08-05, source-verified):** confirmed against the real
> `pi-coding-agent` source (`dist/core/project-trust.js`,
> `dist/core/trust-manager.js`) that upstream `pi` itself has **no**
> capability-restriction sandbox (no network/filesystem allowlisting, no
> per-package permission model) — its only mitigation is (a) a single binary
> "trust this project, yes/no" consent gate before any extension in it runs,
> and (b) the documented human recommendation to *"review source code before
> installing third-party packages"*. pi-desktop's install-consent flow is
> deliberately scoped to **match this exact model** (one consent prompt,
> source-visible package list, no capability sandbox) rather than invent a
> stricter capability-sandboxing layer pi itself doesn't have — staying at
> parity with the upstream CLI/TUI's actual security posture, not exceeding
> or diverging from it. Any future desire for real sandboxing (e.g.
> restricting network access per extension) would be new pi-desktop-specific
> scope beyond what `pi` provides today, and should be raised and decided as
> its own explicit ADR, not folded into this migration.
>
> **Corrected (issue #104):** `ProjectTrustStore` was never actually reused
> as-is for the (now-removed) per-package trust gate. It was found to be
> empirically unsafe for package-source-keyed trust decisions: its
> `normalizeCwd`/`findNearestTrustEntry` treat every key as a filesystem
> path and walk up parent directories, silently inheriting a decision for a
> local-path package nested under an already-decided project directory, and
> silently resolving non-path source strings (`git:...`, `npm:...`) relative
> to `process.cwd()`. A dedicated exact-match key/value store was built
> instead as a stopgap (superseded below).
>
> **Superseded (issue #109) -- the persistent trust gate was removed
> entirely.** Two real bugs shipped in a single day from the same root
> cause: #105 (`DefaultResourceLoader` unconditionally merging every
> `settings.json`-configured package into the loaded extension set once
> #104 shared `agentDir`, bypassing the gate) and #106 (`AgentRuntime
> .listCommands()` building its own resource loader via a separate code
> path that never applied the filter, leaking untrusted command names into
> `/` autocomplete). Both were the same class of bug in two different call
> sites, and there was no structural guarantee a third didn't exist:
> enforcing an app-invented capability gate correctly requires an identical
> filter at *every* place `pi-coding-agent` resolves extensions internally
> -- and every one of those call sites lives inside a library pi-desktop
> does not control. The fix is structural, not another patch: there is no
> more persistent trust/enabled state at all. Instead, a single informed
> consent prompt is shown once, before anything is installed, for every
> source type alike (local-path, git, `npm:`) -- declining it installs
> nothing and writes nothing to `settings.json`. After that, every
> configured package always loads, exactly as it would for the real `pi`
> CLI -- the Settings dialog's package list is exactly the set of packages
> that run, with no hidden accepted/declined state to drift out of sync
> with the library's own resolution. This is a *closer* match to upstream
> `pi`'s own security posture (described just above) than the removed gate
> ever was, not a weaker one: `pi` itself has no persistent per-package
> capability gate either, only a one-time consent prompt.

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

> **Resolved (2026-08-05 spike, evidence-based):** the repo has **no**
> Dependabot/Renovate config today (checked `.github/`) — dependency bumps are
> currently 100% manual (`make version-patch` etc.), and `pi-coding-agent`
> isn't a dependency yet (only `pi-ai`/`pi-agent-core`, both already
> `^0.81.1`, confirming today's baseline is in fact in lockstep). Introducing
> a bot solely for this 3-package constraint would be disproportionate, and
> would only guard *automated* bumps — not a manual `npm install
> pi-ai@newer` alone, the more likely real drift path for a 0.x-line SDK.
>
> **Recommendation:** a tiny CI script,
> `scripts/check-pi-lockstep.mjs` — parses `package.json`, extracts
> `major.minor` for each of `@earendil-works/pi-ai`,
> `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent` that are
> present, and fails if more than one distinct `major.minor` line exists —
> wired into `ci.yml` as one extra step after `npm ci`. This matches the
> repo's own established philosophy (`AGENTS.md`: prefer the tool already
> running as the drift guard over a redundant layered check). Verified for
> real: run against the current `package.json` → passes (both on `0.81.x`);
> simulated drift (`pi-agent-core` rewritten to `^0.75.0`) → correctly exits 1
> with the mismatching lines reported, then reverted. If Dependabot is ever
> introduced for the repo generally, its `groups:` config
> (`groups: { pi-sdk: { patterns: ["@earendil-works/pi-*"] } }`, syntax
> confirmed against GitHub's docs) is a worthwhile complement — grouping any
> bot-proposed bump of the three into one PR — but not a replacement for the
> CI check, since it only constrains Dependabot's own PRs.
- **Arbitrary code execution** (§3.7): Phase 3 must not ship without a real
  pre-install consent prompt.

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

**Phase 3 — providers, runtime install, install consent**
- [ ] `packages:*` IPC (three-file recipe) + fake-desktop-api update.
- [ ] Desktop-owned settings/install dir under `userData`.
- [ ] `registerProvider` bridge.
- [ ] Single pre-install consent prompt before installing any third-party
      source; Settings-dialog package list (source visibility only, no
      persistent capability gate -- see §3.7).
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
