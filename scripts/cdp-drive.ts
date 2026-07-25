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
 *   tsx scripts/cdp-drive.ts <port> text
 *   tsx scripts/cdp-drive.ts <port> send "Who were the ancient Greeks?"
 *   tsx scripts/cdp-drive.ts <port> wait-idle [timeoutMs=60000]
 *   tsx scripts/cdp-drive.ts <port> screenshot > shot-b64.txt
 *
 * `text` dumps `document.body.innerText` (cheap way to confirm state without
 * a full screenshot). `send` fills the composer's real `<textarea>` via its
 * native value setter + `input` event, then dispatches a real `Enter`
 * `keydown` — this is required: a raw `.value = ...` assignment does not
 * trigger React's change detection, and a synthetic Enter without the native
 * setter first won't submit either (see AGENTS.md lesson 12). `wait-idle`
 * polls for the "Stop generation" button to disappear, i.e. streaming
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

type Action = "text" | "send" | "wait-idle" | "screenshot";

interface JsonRpcResponse {
  id?: number;
  result?: {
    result?: { value?: unknown };
    data?: string;
    exceptionDetails?: unknown;
  };
  error?: unknown;
}

async function resolveWebSocketUrl(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/json`);
  const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`No page target found on CDP port ${port}`);
  return page.webSocketDebuggerUrl;
}

function createRpcClient(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  ws.on("message", (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as JsonRpcResponse;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
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
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }

  return { send, evaluate };
}

async function main() {
  const [portArg, action, arg] = process.argv.slice(2) as [string, Action, string | undefined];
  const port = Number(portArg);
  if (!port || !action) {
    console.error(
      "Usage: tsx scripts/cdp-drive.ts <port> <text|send|wait-idle|screenshot> [arg]",
    );
    process.exit(1);
  }

  const wsUrl = await resolveWebSocketUrl(port);
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const client = createRpcClient(ws);
  await client.send("Runtime.enable");

  try {
    if (action === "text") {
      console.log(await client.evaluate("document.body.innerText"));
    } else if (action === "send") {
      if (!arg) throw new Error('"send" requires a message argument');
      const result = await client.evaluate(`
        (function() {
          const textarea = document.querySelector('textarea[placeholder="Send a message…"]');
          if (!textarea) return "NO_TEXTAREA";
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
          ).set;
          nativeSetter.call(textarea, ${JSON.stringify(arg)});
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
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
      console.log(idle ? "IDLE" : "TIMEOUT");
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
      await new Promise((r) => setTimeout(r, 300));
      const res = await client.send("Page.captureScreenshot", { format: "png" });
      console.log(res.data);
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error("ERROR", err.message);
  process.exit(1);
});
