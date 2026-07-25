import { Check, Copy } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { DisplayMessage } from "../state/chat-store";

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

function CodeBlock({ language, value }: { language: string; value: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-surface-border">
      <div className="flex items-center justify-between border-b border-surface-border bg-white/5 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-white/40">
          {language || "text"}
        </span>
        <CopyButton text={value} />
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{ margin: 0, fontSize: "13px", padding: "12px 14px" }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

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
          components={{
            code(props) {
              const { className, children } = props;
              const match = /language-(\w+)/.exec(className ?? "");
              const value = String(children ?? "").replace(/\n$/, "");
              if (match) {
                return <CodeBlock language={match[1]} value={value} />;
              }
              return (
                <code className="rounded bg-white/10 px-1 py-0.5 text-[13px]">
                  {value}
                </code>
              );
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
        {message.streaming && <span className="streaming-cursor" />}
        {message.error && (
          <p className="mt-2 text-xs text-red-400">{message.error}</p>
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
