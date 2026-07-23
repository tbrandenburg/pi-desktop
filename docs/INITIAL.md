# pi-desktop

For a demo tomorrow, I would choose **Electron + React + Pi AI/Pi Agent Core** and accept the larger bundle.

That gives you the highest chance of ending the night with:

* a polished native window;
* streaming LLM chat;
* Windows `.exe`;
* Linux `.AppImage`;
* no separate Node installation;
* no Rust;
* no RPC to an externally installed Pi CLI.

The architecture should be:

```text
Electron application
├── React renderer
│   ├── polished chat interface
│   ├── model/provider selector
│   ├── settings dialog
│   └── streaming message display
│
├── Electron preload bridge
│   └── typed, narrow IPC interface
│
└── Electron main process
    ├── @earendil-works/pi-ai
    ├── @earendil-works/pi-agent-core
    ├── API-key storage
    ├── session state
    └── optional simple tools
```

## The critical scope decision

Build two runtime paths:

### Required demo path

Use `pi-ai` directly for streaming chat.

This must work even if integrating `pi-agent-core` takes longer than expected.

```text
User message
→ React
→ Electron IPC
→ pi-ai
→ provider API
→ streamed events
→ React
```

### Stretch path

Wrap the same model in `pi-agent-core` and add one or two safe tools.

```text
Pi agent
├── read_file
└── list_files
```

Do not let the demo depend on the stretch path.

The demo succeeds when the app looks excellent and streams a response. It does not fail merely because shell tools, extensions, or skills are unfinished.

---

# Target deliverables

By morning, the repository should produce:

```text
dist/
├── Pi-Demo-Portable.exe
└── Pi-Demo-x86_64.AppImage
```

These are single downloadable artifacts per platform.

Internally, Electron still contains Chromium, Node, Pi libraries, and frontend resources. “One executable” here means one user-facing packaged file, not one tiny native process.

## Demo capabilities

The mandatory feature set should be exactly:

1. Launch into a polished welcome screen.
2. Configure one provider API key.
3. Select a model.
4. Start a new conversation.
5. Stream the answer token by token.
6. Render Markdown and code blocks.
7. Stop generation.
8. Preserve the conversation while the app remains open.
9. Show useful errors.
10. Package successfully for Windows and Linux.

Optional only after those work:

* conversation persistence;
* multiple conversations;
* folder selection;
* `AGENTS.md`;
* file attachments;
* agent tools;
* themes;
* provider login flows.

---

# Recommended stack

```text
Runtime:
- Electron
- Node.js runtime bundled by Electron

Frontend:
- React
- TypeScript
- Vite

UI:
- Tailwind CSS
- Radix UI primitives
- Lucide icons
- react-markdown
- remark-gfm
- Shiki or react-syntax-highlighter

State:
- Zustand

LLM:
- @earendil-works/pi-ai
- @earendil-works/pi-agent-core

Validation:
- Zod

Packaging:
- electron-builder
```

For one night, avoid:

* Next.js;
* Tauri;
* Rust;
* SQLite;
* MCP;
* arbitrary Pi extensions;
* automatic model discovery across every provider;
* complex authentication;
* local models;
* terminal emulation;
* file-editing tools.

---

# Repository structure

```text
pi-desktop-demo/
├── package.json
├── electron-builder.yml
├── vite.config.ts
├── tsconfig.json
│
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── windows.ts
│   │   ├── ipc.ts
│   │   ├── llm/
│   │   │   ├── chat-service.ts
│   │   │   ├── model-registry.ts
│   │   │   ├── pi-ai-adapter.ts
│   │   │   └── agent-service.ts
│   │   └── storage/
│   │       └── settings-store.ts
│   │
│   ├── preload/
│   │   ├── index.ts
│   │   └── api-types.ts
│   │
│   ├── renderer/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles.css
│   │   │
│   │   ├── components/
│   │   │   ├── AppShell.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── ChatTimeline.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── Composer.tsx
│   │   │   ├── ModelPicker.tsx
│   │   │   ├── SettingsDialog.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── ThinkingIndicator.tsx
│   │   │   └── ErrorBanner.tsx
│   │   │
│   │   ├── state/
│   │   │   ├── chat-store.ts
│   │   │   └── settings-store.ts
│   │   │
│   │   └── lib/
│   │       ├── markdown.ts
│   │       └── desktop-api.ts
│   │
│   └── shared/
│       ├── events.ts
│       ├── models.ts
│       └── schemas.ts
│
├── assets/
│   ├── icon.ico
│   ├── icon.png
│   └── icon.icns
│
└── scripts/
    └── verify-build.mjs
```

---

# Stable application boundary

Do not let React import Pi directly.

Define your own API:

```ts
export interface DesktopLLMApi {
  listModels(): Promise<ModelInfo[]>;

  startChat(request: StartChatRequest): Promise<{
    requestId: string;
  }>;

  cancelChat(requestId: string): Promise<void>;

  saveProviderSettings(settings: ProviderSettings): Promise<void>;

  getProviderSettings(): Promise<ProviderSettingsSummary>;

  onChatEvent(
    listener: (event: ChatEvent) => void
  ): () => void;
}
```

Events:

```ts
export type ChatEvent =
  | {
      type: "started";
      requestId: string;
    }
  | {
      type: "text-delta";
      requestId: string;
      text: string;
    }
  | {
      type: "reasoning-delta";
      requestId: string;
      text: string;
    }
  | {
      type: "tool-call";
      requestId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: "usage";
      requestId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "completed";
      requestId: string;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
    };
```

This boundary protects the UI from Pi API changes and lets the agent swap between `pi-ai` and `pi-agent-core`.

---

# Main-process implementation

## Phase 1: pi-ai streaming

The main process owns:

* provider credentials;
* model construction;
* the active request;
* abort controllers;
* streaming event conversion.

Conceptually:

```ts
class ChatService {
  private activeRequests = new Map<string, AbortController>();

  async startChat(request: StartChatRequest): Promise<string> {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();

    this.activeRequests.set(requestId, controller);

    void this.runChat(requestId, request, controller.signal);

    return requestId;
  }

  async cancel(requestId: string): Promise<void> {
    this.activeRequests.get(requestId)?.abort();
  }

  private async runChat(
    requestId: string,
    request: StartChatRequest,
    signal: AbortSignal
  ): Promise<void> {
    // Resolve provider/model through pi-ai.
    // Start streamed completion.
    // Translate Pi events into ChatEvent.
    // Send events to the renderer.
  }
}
```

Do not expose raw provider SDK objects to the renderer.

## Phase 2: pi-agent-core

Implement a separate adapter:

```ts
interface RuntimeAdapter {
  stream(
    request: StartChatRequest,
    signal: AbortSignal
  ): AsyncIterable<ChatEvent>;
}
```

Then provide:

```text
DirectChatAdapter
└── pi-ai

AgentChatAdapter
└── pi-agent-core + pi-ai
```

A runtime feature flag can select either implementation:

```ts
const runtime =
  process.env.PI_AGENT_MODE === "true"
    ? new AgentChatAdapter()
    : new DirectChatAdapter();
```

This prevents agent-core integration trouble from blocking the demo.

---

# UI direction

The UI should look like a product, not a developer prototype.

Use a three-region layout:

```text
┌─────────────────────────────────────────────────────┐
│ Top bar: app name          Model selector   Settings│
├───────────────┬─────────────────────────────────────┤
│               │                                     │
│ Conversations │             Chat timeline           │
│               │                                     │
│ New chat      │                                     │
│               │                                     │
│               ├─────────────────────────────────────┤
│               │ Composer                       Send │
└───────────────┴─────────────────────────────────────┘
```

## Visual priorities

### Empty state

The opening screen matters enormously during a demo.

Use:

* a restrained logo;
* one strong headline;
* a subtle explanation;
* three suggestion cards;
* a large centered composer.

Example:

```text
What are we building today?

Ask a question, explore a codebase, or draft an idea.

[ Explain this architecture ]
[ Create an implementation plan ]
[ Review a project folder    ]
```

### Chat messages

Avoid conventional rounded speech bubbles everywhere.

Use:

* compact user message cards;
* spacious assistant responses;
* excellent typography;
* soft borders;
* clear code blocks;
* animated streaming cursor;
* subtle model and timing metadata.

### Composer

The composer should be the visual centerpiece:

* multi-line autosizing input;
* model pill;
* attachment button, even if disabled;
* stop/send button;
* keyboard hint;
* polished focus treatment.

### Streaming

Streaming creates much of the perceived quality.

Implement:

* smooth token accumulation;
* no full component rerender for every character;
* visible animated cursor;
* stop button replacing send;
* status label such as “Thinking” before first token;
* automatic scroll only when the user is near the bottom.

### Theme

Choose one excellent theme, not a theme system.

Recommended:

```text
- dark neutral background
- slightly lighter side panel
- warm white foreground
- subtle translucent borders
- one restrained accent
- generous spacing
- 14–16 px body typography
```

Do not spend the night implementing theme switching.

---

# Execution order for the coding agent

## Milestone 1: Bootable shell

Acceptance criteria:

* Electron launches.
* React renders.
* Frameless or polished native window works.
* Dev hot reload works.
* No Node access exists in the renderer.

Files:

```text
src/main/index.ts
src/preload/index.ts
src/renderer/main.tsx
src/renderer/App.tsx
```

## Milestone 2: Static polished UI

Before any LLM integration, build the complete visual shell using mocked data.

Acceptance criteria:

* sidebar;
* empty state;
* sample conversation;
* composer;
* settings dialog;
* model picker;
* responsive window resizing;
* Markdown/code rendering.

This allows the UI to be reviewed independently of backend failures.

## Milestone 3: Provider settings

Support exactly one initial provider.

Best demo choice:

```text
OpenAI-compatible
```

Fields:

```text
API key
Base URL
Model ID
```

This supports OpenAI, OpenRouter, local gateways, and many compatible services through one setup.

Add Anthropic only if the first provider works early.

Acceptance criteria:

* key can be entered;
* settings persist locally;
* renderer never receives the stored key after saving;
* connection errors are readable.

For an overnight demo, `electron-store` is acceptable. Proper OS keychain storage can follow later.

## Milestone 4: Streaming chat through pi-ai

Acceptance criteria:

* user sends a message;
* assistant response streams;
* generation can be cancelled;
* errors appear inline;
* UI stays responsive;
* Markdown renders correctly after and during streaming.

This is the principal success milestone.

## Milestone 5: Packaging

Configure:

```yaml
win:
  target:
    - portable
    - nsis

linux:
  target:
    - AppImage
```

Acceptance criteria:

* packaged app launches without Node installed;
* frontend assets load;
* Pi imports resolve;
* provider request works in production build;
* icons and application name are correct.

Do packaging before optional features. Many projects discover packaging issues too late.

## Milestone 6: Pi agent-core

Only after packaged streaming chat works:

* wrap the model in Pi agent-core;
* add session state;
* add `list_files`;
* add `read_file`;
* expose tool activity in the UI.

No shell execution for the first demo unless everything else is stable.

## Milestone 7: Demo polish

Add:

* attractive loading state;
* transition animations;
* first-token timing;
* copy-code button;
* retry action;
* model label;
* keyboard shortcuts;
* seeded suggestion prompts;
* sample conversation fallback.

---

# Packaging configuration

A representative `electron-builder.yml`:

```yaml
appId: dev.pi.desktop.demo
productName: Pi Desktop Demo

directories:
  output: release
  buildResources: assets

files:
  - dist-renderer/**
  - dist-main/**
  - package.json

asar: true

win:
  icon: assets/icon.ico
  target:
    - target: portable
      arch:
        - x64
    - target: nsis
      arch:
        - x64

linux:
  icon: assets/icon.png
  category: Development
  target:
    - target: AppImage
      arch:
        - x64

portable:
  artifactName: "${productName}-${version}-Portable.${ext}"

nsis:
  oneClick: true
  perMachine: false

artifactName: "${productName}-${version}-${os}-${arch}.${ext}"
```

Potential Pi or native dependencies may need to be unpacked from ASAR:

```yaml
asarUnpack:
  - "**/*.node"
  - "**/*.wasm"
```

Only add this if the production build shows it is required.

---

# Package scripts

```json
{
  "scripts": {
    "dev": "concurrently \"vite\" \"tsx scripts/run-electron-dev.ts\"",
    "build:renderer": "vite build",
    "build:main": "tsc -p tsconfig.main.json",
    "build": "npm run build:renderer && npm run build:main",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder",
    "dist:win": "npm run build && electron-builder --win portable nsis",
    "dist:linux": "npm run build && electron-builder --linux AppImage",
    "check": "tsc --noEmit && eslint .",
    "test": "vitest run"
  }
}
```

Building a Windows executable is most reliable on Windows. Building an AppImage is most reliable on Linux or inside a Linux CI runner.

For tomorrow, use GitHub Actions with separate Windows and Linux jobs if both artifacts are required.

---

# CI workflow

```text
matrix:
- windows-latest → portable EXE and NSIS
- ubuntu-latest  → AppImage
```

Workflow stages:

```text
checkout
setup Node 22
npm ci
npm run check
npm run build
npm run dist for platform
upload artifacts
```

Do not rely on cross-compiling the Windows artifact from Linux.

---

# Failure-prevention rules for the overnight agent

Give the agent these explicit rules:

1. Do not change the architecture.
2. Do not introduce Tauri, Rust, Next.js, or a server.
3. Do not implement full Pi CLI compatibility.
4. Do not implement arbitrary extensions.
5. Do not begin agent tools until packaged streaming chat works.
6. Keep all Pi imports in `src/main/llm`.
7. Keep the React renderer free of Node APIs.
8. Never place API keys in React state after persistence.
9. Test the production package, not only development mode.
10. Commit after every completed milestone.
11. Maintain a `STATUS.md` with completed items and blockers.
12. If Pi agent-core integration blocks progress, retain pi-ai direct chat and move on.

---

# Suggested overnight agent task specification

Use something close to this as the main instruction:

```text
Build a polished cross-platform Electron desktop demo using React, TypeScript,
Vite, @earendil-works/pi-ai, and optionally @earendil-works/pi-agent-core.

Primary goal:
Produce a working Windows portable EXE and Linux AppImage that launch a visually
excellent chat application and stream responses from an OpenAI-compatible LLM.

Architecture constraints:
- Electron main process owns Pi, provider credentials, networking, and sessions.
- React renderer is unprivileged.
- A preload script exposes a narrow typed IPC API.
- Do not use Rust, Tauri, Next.js, an external Node server, or a separately
  installed Pi CLI.
- Use pi-ai directly for the guaranteed chat path.
- Integrate pi-agent-core only after direct streaming chat and packaging work.
- Wrap Pi behind an internal RuntimeAdapter interface.
- Never import Pi packages from the renderer.

Mandatory features:
- Polished dark desktop UI
- Sidebar and new-conversation action
- Excellent empty state
- Model selector
- Provider settings dialog
- OpenAI-compatible API key, base URL, and model settings
- Streaming Markdown responses
- Syntax-highlighted code blocks
- Stop generation
- Copy response/code
- Inline errors
- Responsive layout
- Windows portable EXE
- Linux AppImage

Optional features, in priority order:
1. Persist conversations
2. Integrate pi-agent-core
3. list_files tool
4. read_file tool
5. AGENTS.md loading

Work milestone by milestone.
After each milestone:
- run type checking;
- run tests;
- update STATUS.md;
- commit the result.

Do not sacrifice the mandatory packaged chat demo for optional agent features.
```

---

# Demo script

Prepare a deterministic 90-second demonstration:

1. Launch the executable.
2. Show the empty state and model selector.
3. Open settings and show provider configuration.
4. Send:

```text
Explain the architecture of this desktop application in five concise steps,
then provide a small TypeScript example.
```

5. Show streaming Markdown and syntax-highlighted code.
6. Stop generation midway and retry.
7. Send a second prompt demonstrating retained context.
8. If agent-core works, open a small sample folder and ask it to summarize `README.md`.

Have a pre-recorded or mocked conversation available behind a hidden demo mode in case the provider network fails. That is not cheating; it is basic presentation risk management.

## Final recommendation

For tomorrow:

```text
Electron
+ React
+ pi-ai
+ optional pi-agent-core
+ electron-builder
```

Do not optimize bundle size tonight. Optimize for:

```text
launch reliability
streaming reliability
visual quality
packaging reliability
```

A polished 140 MB executable that works is vastly better than an elegant 35 MB architecture that does not package by morning.
