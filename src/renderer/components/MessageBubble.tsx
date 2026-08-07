import { AlertTriangle, Check, Copy } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DisplayMessage } from "../state/chat-store";
// Type-only import, erased entirely at build time (no runtime/bundle cost):
// pulls @types/react-syntax-highlighter's ambient submodule declarations
// into the program so the dynamic submodule imports below type-check,
// without importing any runtime code from the package's barrel `index.js`.
import type {} from "react-syntax-highlighter";

// PrismAsyncLight is imported from its own submodule path (not the package's
// barrel `index.js`) so bundlers don't also pull in the sibling `Prism`/
// `PrismAsync` exports, which synchronously bundle all ~250 language
// grammars regardless of which export is actually used. PrismAsyncLight
// already loads each language grammar on demand internally (see
// react-syntax-highlighter's async-syntax-highlighter.js) the first time a
// given `language` prop is rendered, re-rendering once it's ready — no
// manual registration needed here. An unsupported/unknown language name is
// normalized to plain, unhighlighted text by the component itself.
const HighlightedCode = lazy(async () => {
  const [{ default: SyntaxHighlighter }, { default: oneDark }] = await Promise.all([
    import("react-syntax-highlighter/dist/esm/prism-async-light"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-dark"),
  ]);

  return {
    default: function HighlightedCodeInner({
      language,
      value,
    }: {
      language: string;
      value: string;
    }) {
      return (
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          customStyle={{
            margin: 0,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "13px",
            padding: "12px 14px",
          }}
        >
          {value}
        </SyntaxHighlighter>
      );
    },
  };
});

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      title={copied ? "Copied" : "Copy"}
      className={className ?? "text-white/40 transition hover:text-white"}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const MARKDOWN_CLASSNAME = [
  // prose-invert only in dark mode — the `dark:` variant is wired to our
  // data-theme attribute in styles.css, so prose (code/links/headings)
  // follows the theme toggle instead of forcing the dark palette everywhere.
  "prose prose-sm dark:prose-invert max-w-none",
  "prose-headings:mt-3 prose-headings:mb-2 prose-headings:font-semibold",
  "first:prose-headings:mt-0 prose-p:my-2 prose-ul:my-2 prose-ol:my-2",
  "prose-pre:bg-transparent prose-pre:p-0",
].join(" ");

function CodeBlock({ language, value }: { language: string; value: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-surface-border">
      <div className="flex items-center justify-between border-b border-surface-border bg-surface-hover px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-white/40">
          {language || "text"}
        </span>
        <CopyButton text={value} />
      </div>
      <Suspense
        fallback={
          <pre
            className="m-0 overflow-x-auto p-3 text-[13px]"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          >
            <code>{value}</code>
          </pre>
        }
      >
        <HighlightedCode language={language || "text"} value={value} />
      </Suspense>
    </div>
  );
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

  if (message.error) {
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[80%] items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm leading-relaxed text-red-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p>{message.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[70%] rounded-2xl bg-accent/15 px-4 py-2.5 text-sm text-white"
            : "max-w-[80%] rounded-2xl border border-surface-border bg-surface-panel px-5 py-4 text-sm leading-relaxed text-white/90"
        }
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          className={MARKDOWN_CLASSNAME}
          components={{
            code(props) {
              const { className, children } = props;
              const match = /language-(\w+)/.exec(className ?? "");
              const value = String(children ?? "").replace(/\n$/, "");
              if (match) {
                return <CodeBlock language={match[1]} value={value} />;
              }
              return (
                <code className="rounded bg-surface-hover px-1 py-0.5 text-[13px]">
                  {value}
                </code>
              );
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
        {message.streaming && <span className="streaming-cursor" />}
        {message.retrying && (
          <p className="mt-1 text-xs text-white/40">
            Retrying… ({message.retrying.attempt}/{message.retrying.maxAttempts})
          </p>
        )}
        {!isUser && !message.streaming && message.content && (
          <div className="mt-2 flex justify-end pt-2">
            <CopyButton
              text={message.content}
              className="flex items-center gap-1 text-[11px] text-white/40 transition hover:text-white"
            />
          </div>
        )}
      </div>
    </div>
  );
}
