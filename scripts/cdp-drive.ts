/**
 * Drives a real, already-running Electron/Chromium window via the Chrome
 * DevTools Protocol (CDP) instead of OS-level input injection or Playwright's
 * own bundled browser. Used to manually verify the *packaged* app end-to-end
 * (real IPC, real provider HTTP calls, no mocks) — see AGENTS.md's "Testing
 * the production package" section for the full launch procedure this script
 * assumes has already happened:
 *
 *   1. `npm run build && npx electron-builder --linux AppImage`
 *   2. Launch the AppImage detached with `--remote-debugging-port=<port>`
 *      and a unique `--user-data-dir` (or the real default one, if you
 *      intentionally want to inherit already-saved provider credentials —
 *      see AGENTS.md lesson below on the `app-settings` provider gate).
 *
 * Usage (no build step needed, run directly via tsx):
 *
 *   tsx scripts/cdp-drive.ts <port> ready [timeoutMs=30000]
 *   tsx scripts/cdp-drive.ts <port> text
 *   tsx scripts/cdp-drive.ts <port> send "Who were the ancient Greeks?"
 *   tsx scripts/cdp-drive.ts <port> wait-idle [timeoutMs=60000]
 *   tsx scripts/cdp-drive.ts <port> screenshot <output.png>
 *   tsx scripts/cdp-drive.ts <port> chat "Reply with exactly PONG" <output.png>
 *
 * `text` dumps `document.body.innerText` (cheap way to confirm state without
 * a full screenshot). `send` fills the composer's real `<textarea>` via its
 * native value setter + `input` event, then dispatches a real `Enter`
 * `keydown` — this is required: a raw `.value = ...` assignment does not
 * trigger React's change detection, and a synthetic Enter without the native
 * setter first won't submit either (see AGENTS.md lesson 12). It also yields
 * one animation frame + a macrotask between the `input` event and the Enter
 * keydown: dispatching both synchronously in the same tick fires `onKeyDown`
 * before React has flushed the `onChange`-driven state update, so the
 * submit handler's closure still sees the stale (empty) value and silently
 * no-ops — the DOM textarea shows the typed text (set directly via the
 * native setter) but the message was never actually sent. If the value
 * still doesn't match after yielding, `send` returns `VALUE_NOT_COMMITTED`
 * instead of a false-positive `SENT`. `wait-idle` polls for the "Stop
 * generation" button to disappear, i.e. streaming
 * finished — give real (non-fake) providers up to 60s, some free-tier models
 * are slow (see AGENTS.md's packaged-app testing section, point 5).
 *
 * Requires the `ws` package. It is intentionally *not* a package.json
 * dependency (see AGENTS.md's Rolldown/pi-ai lesson on hiding dynamic
 * imports from tsc) — `ws` is already present transitively via other
 * dependencies. If `require.resolve("ws")` ever fails (a future dependency
 * bump drops it), install it ad hoc: `npm install -D ws` and re-add here,
 * or fall back to plain WebSocket if running under a Node version that has
 * it built in.
 */
import WebSocket from "ws";

type Action = "ready" | "text" | "send" | "wait-idle" | "screenshot" | "chat";

interface JsonRpcResponse {
  id?: number;
  result?: {
    result?: { value?: unknown };
    data?: string;
    exceptionDetails?: unknown;
  };
  error?: unknown;
}

function createRpcClient(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: JsonRpcResponse["result"]) => void; reject: (e: Error) => void }>();

  ws.on("message", (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as JsonRpcResponse;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse["result"]> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression: string): Promise<unknown> {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result?.result?.value;
  }

  return { send, evaluate };
}

async function resolveWebSocketUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "CDP endpoint is not ready";
  while (Date.now() < deadline) {
    try {
      return await resolveWebSocketUrlOnce(port);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${lastError} (after ${timeoutMs}ms)`);
}

async function resolveWebSocketUrlOnce(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/json`);
  if (!res.ok) throw new Error(`CDP returned HTTP ${res.status}`);
  const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error(`No page target found on CDP port ${port}`);
  return page.webSocketDebuggerUrl;
}

async function connect(port: number, timeoutMs: number) {
  const ws = new WebSocket(await resolveWebSocketUrl(port, timeoutMs));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const client = createRpcClient(ws);
  await client.send("Runtime.enable");
  return { ws, client };
}

async function main() {
  const [portArg, action, arg] = process.argv.slice(2) as [string, Action, string | undefined];
  const port = Number(portArg);
  if (!port || !action) {
    console.error(
      "Usage: tsx scripts/cdp-drive.ts <port> <ready|text|send|wait-idle|screenshot|chat> [arg] [output.png]",
    );
    process.exit(1);
  }

  const readyTimeoutMs = action === "ready" ? (arg ? Number(arg) : 30000) : 30000;
  const { ws, client } = await connect(port, readyTimeoutMs);

  try {
    if (action === "ready") {
      console.log("READY");
    } else if (action === "text") {
      console.log(await client.evaluate("document.body.innerText"));
    } else if (action === "send") {
      if (!arg) throw new Error('"send" requires a message argument');
      const result = await client.evaluate(`
        (async function() {
          const textarea = document.querySelector('textarea[placeholder="Send a message…"]');
          if (!textarea) return "NO_TEXTAREA";
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
          ).set;
          nativeSetter.call(textarea, ${JSON.stringify(arg)});
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          // Yield to let React flush the onChange-driven state update before
          // the Enter keydown fires — otherwise onKeyDown's submit() closure
          // still reads the stale (empty) value from the prior render and
          // silently no-ops, leaving the typed text sitting in the composer
          // with no visible error. A real user's keystrokes are never
          // dispatched in the same synchronous tick, so this only bites
          // synthetic same-tick automation.
          await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          if (textarea.value !== ${JSON.stringify(arg)}) return "VALUE_NOT_COMMITTED";
          textarea.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", bubbles: true, cancelable: true
          }));
          return "SENT";
        })()
      `);
      console.log(result);
    } else if (action === "wait-idle") {
      const timeoutMs = arg ? Number(arg) : 60000;
      const start = Date.now();
      let idle = false;
      while (Date.now() - start < timeoutMs) {
        const state = await client.evaluate(`
          (function() {
            return document.querySelector('button[title="Stop generation"]') ? "streaming" : "idle";
          })()
        `);
        if (state === "idle") {
          idle = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!idle) throw new Error(`Generation did not become idle within ${timeoutMs}ms`);
      console.log("IDLE");
    } else if (action === "screenshot") {
      await client.evaluate(`
        (function() {
          window.scrollTo(0, document.body.scrollHeight);
          for (const el of document.querySelectorAll('*')) {
            if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
          }
          return "scrolled";
        })()
      `);
      const res = (await client.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
      if (!arg) throw new Error('"screenshot" requires an output path');
      if (!res.data) throw new Error("CDP did not return screenshot data");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(arg, Buffer.from(res.data, "base64"));
      console.log(`SCREENSHOT ${arg}`);
    } else if (action === "chat") {
      if (!arg) throw new Error('"chat" requires a message argument');
      const outputPath = process.argv[5];
      if (!outputPath) throw new Error('"chat" requires an output screenshot path');
      const before = String(await client.evaluate("document.body.innerText"));
      const beforeAssistantCount = Number(
        await client.evaluate("document.querySelectorAll('div.flex.justify-start').length"),
      );
      const sent = await client.evaluate(`
         (async function() {
           const textarea = document.querySelector('textarea[placeholder="Send a message…"]');
           if (!textarea) return "NO_TEXTAREA";
           const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
           if (!setter) return "NO_NATIVE_SETTER";
           setter.call(textarea, ${JSON.stringify(arg)});
           textarea.dispatchEvent(new Event("input", { bubbles: true }));
           await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
           if (textarea.value !== ${JSON.stringify(arg)}) return "VALUE_NOT_COMMITTED";
           textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
           return "SENT";
         })()
      `);
      if (sent !== "SENT") throw new Error(`Message submission failed: ${String(sent)}`);
      const submitted = await client.evaluate(`
         (async function() {
           const deadline = Date.now() + 5000;
           while (Date.now() < deadline) {
             const textarea = document.querySelector('textarea[placeholder="Send a message…"]');
             if (textarea && textarea.value === "") return true;
             await new Promise((resolve) => setTimeout(resolve, 100));
           }
           return false;
         })()
      `);
      if (submitted !== true) throw new Error("Composer did not clear after submission");
      const deadline = Date.now() + 60000;
      let observedStreaming = false;
      let verifiedReply = false;
      while (Date.now() < deadline) {
        const state = await client.evaluate(`
           (() => ({
             streaming: Boolean(document.querySelector('button[title="Stop generation"]')),
             body: document.body.innerText,
             errors: document.querySelectorAll('[class*="border-red-500/30"]').length,
            assistantCount: document.querySelectorAll("div.flex.justify-start").length,
           }))()
        `) as { streaming: boolean; body: string; errors: number; assistantCount: number };
        observedStreaming ||= state.streaming;
        if (!state.streaming && observedStreaming) {
          if (state.errors > 0) throw new Error("Packaged chat rendered an error");
          if (state.body === before || !state.body.includes(arg) || state.assistantCount <= beforeAssistantCount) {
            throw new Error("Packaged chat produced no visible assistant reply");
          }
          verifiedReply = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!verifiedReply) throw new Error("Packaged chat did not become idle with a reply within 60000ms");
      const screenshot = (await client.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
      if (!screenshot.data) throw new Error("CDP did not return screenshot data");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
      console.log(`CHAT_OK SCREENSHOT ${outputPath}`);
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error("ERROR", err.message);
  process.exit(1);
});
