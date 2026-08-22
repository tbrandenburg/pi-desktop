import os from "node:os";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import { startChatRequestSchema, providerSettingsSchema, workspaceDirSchema } from "../shared/schemas";
import type { CommandInfo, ExtensionUIResponse, ModelInfo, PackageInfo, WorkspaceInfo } from "../shared/events";
import { ChatService } from "./chat/service";
import {
  createModelsRegistryLoader,
  modelsLoadersFor,
  type ModelsLoaders,
  type ModelsRegistryInputs,
} from "./model/registry";
import { listConfiguredModels, resolvePiDefault } from "./model/pi-config";
import { getCachedModels, invalidateModelsCache, setCachedModels } from "./model/registry-cache";
import { applyStatus, onStatusChange } from "./model/model-status";
import { SettingsStore } from "./settings/store";
import { SessionService } from "./session/service";
import { AgentRuntime } from "./agent/runtime";
import { resolveBundledExtensionPaths } from "./agent/bundled-extensions";
import { IpcUIContextBridge } from "./agent/ui-context";
import { PackageService } from "./packages/service";
import type { AgentCoreLoaders } from "./agent/core";
import type { CodingAgentLoaders } from "./agent/coding-agent-loaders";
import { BridgeEvents, createBridgeWindow, type BridgeWindowLike } from "./web-bridge/events";

/**
 * One channel-name -> handler-function entry. First parameter mirrors
 * `ipcMain.handle`'s listener shape (an unused "event" placeholder for
 * handlers that take real args) so handler bodies below are unchanged from
 * before this registry existed; the web-bridge HTTP server (issue #228)
 * calls the same functions with `undefined` in that slot.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcHandlerFn = (...args: any[]) => unknown;

/**
 * Every `DesktopAgentApi` request/response channel's handler, reachable by
 * name -- built once and registered against both Electron's `ipcMain` (this
 * module) and the opt-in local web-bridge HTTP server (issue #228,
 * `web-bridge/server.ts`), so a second transport calls the exact same
 * functions instead of duplicating handler bodies.
 */
export interface IpcHandlerRegistry {
  handlers: Record<string, IpcHandlerFn>;
  /** Push/streaming side of the same 3 `on*` subscriptions, shared by both transports. */
  bridgeEvents: BridgeEvents;
}

export interface RegisterIpcHandlersDeps {
  agentCoreLoaders?: AgentCoreLoaders;
  codingAgentLoaders?: CodingAgentLoaders;
  /**
   * Workspace directory resolved from a CLI launch argument (e.g.
   * `pi-desktop .`, see #164), already persisted via
   * `settingsStore.setWorkspaceDir()` by the caller. Seeds
   * `currentWorkspaceDir` synchronously so the renderer's initial
   * `workspace:get` call reflects it immediately, without waiting on the
   * async `settingsStore.getWorkspaceDir()` load below.
   */
  initialWorkspaceDir?: string;
  /**
   * Test-only override for the bundled first-party extension entry files
   * normally resolved from `app.isPackaged`/`process.resourcesPath` below.
   * Lets a test point the *real* (unstubbed) registry build at an inline
   * fixture extension instead of the repo's own `extensions/` directory.
   */
  bundledExtensionPaths?: string[];
  /**
   * Test-only override for the `AgentRuntime` handed to `ChatService`,
   * mirroring the injection seam `ChatService` already exposes (see
   * `chat/service.test.ts`). Lets a test exercise the real model-resolution
   * path of a chat turn without spinning a real `AgentSession`.
   */
  agentRuntime?: AgentRuntime;
  /**
   * Injectable pi-ai module loaders for the chat path's registry build.
   * Production omits this (the real `nativeDynamicImport`-hidden defaults
   * apply); tests must inject `realModelsLoaders`, because the hidden
   * dynamic-import trick cannot run under Vitest's vm pool at all (see
   * AGENTS.md, "Diagnosing bugs that only reproduce in the packaged app"
   * #4). Injecting the *module loaders* is not the same as stubbing the
   * registry build itself -- the real `buildModelsRegistry` still runs.
   */
  modelsLoaders?: ModelsLoaders;
}

/**
 * Builds every `DesktopAgentApi` channel's handler function plus the shared
 * push-event bus, without registering anything against `ipcMain` -- the
 * reusable core both `registerIpcHandlers()` (below, real Electron IPC) and
 * the opt-in web-bridge server (issue #228) register against, so a second
 * transport never duplicates a handler body.
 */
export function createIpcHandlerRegistry(
  getRealWindow: () => BridgeWindowLike | null,
  deps: RegisterIpcHandlersDeps = {},
): IpcHandlerRegistry {
  const bridgeEvents = new BridgeEvents();
  const getWindow = createBridgeWindow(getRealWindow, bridgeEvents);
  const handlers: Record<string, IpcHandlerFn> = {};

  const settingsStore = new SettingsStore();
  let currentWorkspaceDir = deps.initialWorkspaceDir ?? "";
  const getWorkspaceDir = () => currentWorkspaceDir;
  void settingsStore.getWorkspaceDir().then((dir) => {
    currentWorkspaceDir = dir;
  });

  const sessionService = new SessionService(getWorkspaceDir, deps.agentCoreLoaders, deps.codingAgentLoaders);

  // Issue #179 part C: last-known-full `model:list` result (post-`applyStatus`
  // reordering/defaulting, pre-this-module's-own-`applyStatus` re-apply),
  // keyed by `id`. `onStatusChange` below only tells us a bare
  // `{ providerId? , modelId? }` changed, not a full `ModelInfo` -- this map
  // is what turns that into a valid, complete `model:list-updated` payload
  // for the renderer's existing `mergeModelsById` merge logic (see
  // `model-status.ts`'s `onStatusChange` doc comment, and `chat-store.ts`).
  let lastFullModels: ModelInfo[] = [];
  onStatusChange(() => {
    if (lastFullModels.length === 0) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("model:list-updated", applyStatus(lastFullModels));
  });

  // Shared across chat's extension `ctx.ui.*` dialogs (#91) AND the
  // package-install consent prompt (#109) -- one real modal mechanism,
  // never two parallel ones.
  const uiContextBridge = new IpcUIContextBridge((request) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // Issue #137: setTitle() must change the real OS window title, not just
    // the in-renderer header text -- this is the literal acceptance
    // criterion, so it's applied directly here alongside the renderer push.
    if (request.kind === "set-title") win.setTitle(request.title);
    win.webContents.send("extension-ui:request", request);
  });

  const packageService = new PackageService(
    (source) =>
      uiContextBridge.uiContext.confirm(
        "Install this package?",
        `"${source}" will run with full system access, exactly like any other pi extension (npm sources also run install scripts immediately, before any review). Only install packages from sources you control or fully trust.`,
      ),
    deps.codingAgentLoaders,
  );

  // pi-desktop's own first-party extension packages (issue #192):
  // `<repo>/extensions/*` in dev, `<process.resourcesPath>/pi-extensions/*`
  // once packaged (see `electron-builder.yml`'s `extraResources`).
  // `app.isPackaged`/`process.resourcesPath` are Electron-runtime-only, so
  // the resolution happens here (the real Electron entry point) and the
  // resulting absolute paths are injected into the two consumers -- exactly
  // the pattern the removed `resolvePiPackagesReadOnlyToolsDir` used
  // (issue #97), generalized from one hardcoded package to a directory of
  // many.
  const bundledExtensionPaths =
    deps.bundledExtensionPaths ??
    resolveBundledExtensionPaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: process.cwd(),
    });

  const registryInputs: ModelsRegistryInputs = {
    homeDir: os.homedir(),
    cwd: process.cwd(),
    bundledExtensionPaths,
    loaders: {
      ...deps.modelsLoaders,
      codingAgentLoaders: deps.codingAgentLoaders,
    },
  };

  const agentRuntime = deps.agentRuntime ?? new AgentRuntime(deps.codingAgentLoaders, bundledExtensionPaths);
  const chatService = new ChatService(
    settingsStore,
    getWindow,
    // Issue #211: the chat path must build its registry from the exact same
    // inputs the picker does (`model:list` below) -- otherwise a model the
    // picker lists (e.g. a bundled extension's provider) is rejected on send
    // with "is not configured". Passing `undefined` here previously fell
    // back to `ChatService`'s own no-argument default, which sees neither
    // the bundled extension paths nor this process's homeDir/cwd.
    createModelsRegistryLoader(registryInputs),
    getWorkspaceDir,
    agentRuntime,
    uiContextBridge,
  );

  handlers["app:get-version"] = ((): string => {
    return app.getVersion();
  });

  handlers["model:list"] = (async (): Promise<ModelInfo[]> => {
    // The model list is sourced entirely from the providers configured in
    // `.pi/agent` (project-local, then global) -- no hardcoded placeholder
    // models. If the user hasn't saved their own settings yet, the model
    // resolved from `.pi/agent` is put first so it's selected by default
    // and chat works out of the box.
    const settings = await settingsStore.get();
    // Only register the app's own settings as their own model source when
    // the user actually saved them explicitly -- `settings` here may just be
    // resolvePiDefault()'s .pi/agent-derived fallback (see SettingsStore.get()),
    // and registering that as a separate "app-settings" provider would just
    // duplicate the underlying .pi/agent provider under a misleading label.
    const hasSavedApiKey = await settingsStore.hasSavedApiKey();
    const appSettingsInput = hasSavedApiKey ? settings : undefined;
    const { homeDir, cwd } = registryInputs;
    // Issue #166 part A: `listConfiguredModels` rebuilds the whole registry
    // (including the ~2.3-2.6s extension-activation pass) on every call --
    // cache it, keyed by the inputs that actually affect the result, and
    // only rebuild when nothing cached matches (see registry-cache.ts).
    let models = getCachedModels(homeDir, cwd, appSettingsInput);
    if (!models) {
      // Issue #167 part C: on a cold (uncached) call, push progressive,
      // partial results to the renderer as each provider source resolves,
      // instead of leaving it blocked until the whole registry (including
      // the slow extensionProviderSource pass) finishes. Purely an
      // additional side-channel -- the final `models` value returned below
      // is unaffected.
      models = await listConfiguredModels(homeDir, cwd, appSettingsInput, modelsLoadersFor(registryInputs), (partial) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("model:list-updated", partial);
      });
      setCachedModels(homeDir, cwd, appSettingsInput, models);
    }
    const piDefault = await resolvePiDefault(homeDir, cwd, modelsLoadersFor(registryInputs));

    // `piDefault.model` and `settings.model` are both *bare* model ids (see
    // ResolvedPiDefault/StoredSettings) -- equal here means the currently
    // active settings genuinely are this resolved .pi/agent default (not a
    // coincidental same-name match against an unrelated custom model),
    // since `settings.model` only ever equals `piDefault.model` when
    // SettingsStore.get() itself returned the fallback value. `models`
    // entries use the fully-qualified id (`piDefault.label`), so match on
    // that instead.
    //
    // Issue #179 part C: `lastFullModels` is updated below so the
    // `onStatusChange` subscription (registered once, above) can push a
    // live `model:list-updated` delta the moment a background reachability
    // probe or a real chat use changes a model's status, instead of
    // requiring the next `model:list` call (e.g. app restart) to reflect it.
    if (piDefault && piDefault.model === settings.model) {
      const providerId = piDefault.label.slice(0, piDefault.label.indexOf("/"));
      const defaultEntry =
        models.find((m) => m.id === piDefault.label) ??
        ({
          id: piDefault.label,
          label: piDefault.label,
          providerId,
          configured: true,
          credentialState: "configured",
        } satisfies ModelInfo);
      lastFullModels = [defaultEntry, ...models.filter((m) => m.id !== piDefault.label)];
      return applyStatus(lastFullModels);
    }

    lastFullModels = models;
    return applyStatus(lastFullModels);
  });

  handlers["chat:start"] = (async (_event, rawRequest: unknown) => {
    const request = startChatRequestSchema.parse(rawRequest);
    const requestId = await chatService.startChat(request);
    return { requestId };
  });

  handlers["chat:cancel"] = (async (_event, requestId: string) => {
    chatService.cancel(requestId);
  });

  handlers["chat:list-commands"] = (async (): Promise<CommandInfo[]> => {
    return chatService.listCommands();
  });

  handlers["extension-ui:respond"] = (async (_event, requestId: string, response: ExtensionUIResponse) => {
    chatService.respondExtensionUI(requestId, response);
  });

  handlers["settings:save"] = (async (_event, rawSettings: unknown) => {
    const settings = providerSettingsSchema.parse(rawSettings);
    await settingsStore.save(settings);
    invalidateModelsCache();
  });

  handlers["settings:get"] = (async () => {
    return settingsStore.getSummary();
  });

  handlers["sessions:list"] = (async () => {
    return sessionService.list();
  });

  handlers["sessions:get"] = (async (_event, id: string) => {
    return sessionService.get(id);
  });

  handlers["sessions:delete"] = (async (_event, id: string) => {
    await sessionService.delete(id);
  });

  handlers["workspace:get"] = (async (): Promise<WorkspaceInfo> => {
    const dir = await settingsStore.getWorkspaceDir();
    currentWorkspaceDir = dir;
    return { dir };
  });

  handlers["workspace:choose"] = (async (): Promise<WorkspaceInfo | null> => {
    // Real Electron `BrowserWindow` only -- `dialog.showOpenDialog` has no
    // browser equivalent and is unsupported over the web-bridge transport
    // (issue #228 non-goals), where `getRealWindow()` is always `null`.
    const win = getRealWindow() as unknown as BrowserWindow | null;
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;

    const dir = workspaceDirSchema.parse(result.filePaths[0]);
    await settingsStore.setWorkspaceDir(dir);
    currentWorkspaceDir = dir;
    return { dir };
  });

  handlers["packages:list"] = (async (): Promise<PackageInfo[]> => {
    return packageService.list();
  });

  handlers["packages:install"] = (async (_event, source: string): Promise<PackageInfo> => {
    const result = await packageService.install(source);
    invalidateModelsCache();
    return result;
  });

  handlers["packages:remove"] = (async (_event, source: string): Promise<void> => {
    await packageService.remove(source);
    invalidateModelsCache();
  });

  handlers["packages:update"] = (async (_event, source: string): Promise<void> => {
    await packageService.update(source);
    invalidateModelsCache();
  });

  handlers["extension-ui:get-tools-expanded"] = ((): boolean => {
    return uiContextBridge.uiContext.getToolsExpanded();
  });

  handlers["extension-ui:report-tools-expanded"] = ((_event, value: boolean): void => {
    uiContextBridge.reportToolsExpanded(value);
  });

  handlers["extension-ui:get-editor-text"] = ((): string => {
    return uiContextBridge.uiContext.getEditorText();
  });

  handlers["extension-ui:report-editor-text"] = ((_event, text: string): void => {
    uiContextBridge.reportEditorText(text);
  });

  handlers["extension-ui:query-autocomplete"] = (async (_event, text: string) => {
    return uiContextBridge.queryAutocomplete(text);
  });

  // `registerShortcut` is registered on the extension context (alongside
  // `registerCommand`), not on `ExtensionUIContext` -- and unlike `commands`,
  // pi-coding-agent's public `extensionsResult.extensions[]` shape exposes no
  // equivalent `shortcuts` collection to discover or invoke against (verified
  // by grepping `@earendil-works/pi-coding-agent`'s own `.d.ts` output: no
  // "shortcuts" property exists anywhere in its public types). There is
  // currently no supported way to list or trigger extension-registered
  // shortcuts from outside a live TUI session, so these honestly report
  // "none registered" rather than fabricating support pi-coding-agent
  // doesn't expose (see issue #142's handoff notes / follow-up issue).
  handlers["shortcuts:list"] = (() => {
    return [];
  });

  handlers["shortcuts:trigger"] = (() => {});

  return { handlers, bridgeEvents };
}

/**
 * Registers every `DesktopAgentApi` channel against Electron's real
 * `ipcMain` -- unchanged behavior for the packaged app. Returns the same
 * `IpcHandlerRegistry` `createIpcHandlerRegistry()` built, so
 * `main/index.ts` can additionally hand it to the opt-in web-bridge server
 * (issue #228) without building a second, divergent set of services.
 */
export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  deps: RegisterIpcHandlersDeps = {},
): IpcHandlerRegistry {
  const registry = createIpcHandlerRegistry(getWindow, deps);
  for (const [channel, fn] of Object.entries(registry.handlers)) {
    ipcMain.handle(channel, (event: unknown, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(event, ...args),
    );
  }
  return registry;
}
