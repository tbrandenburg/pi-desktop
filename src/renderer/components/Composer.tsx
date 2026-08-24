import { Loader2, Mic, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import { useChatStore } from "../state/chat-store";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { desktopApi } from "../lib/desktop-api";
import type { AutocompleteSuggestion } from "../../shared/events";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the `data:<mime>;base64,` prefix -- callers only want the
      // raw base64 payload, matching the `saveRecording(base64Audio, mimeType)`
      // contract (mime type is passed separately).
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function Composer() {
  const [value, setValue] = useState("");
  const [extensionSuggestions, setExtensionSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastEditorPush = useExtensionUIStore((state) => state.dataPushes["set-editor-text"]);
  const appliedEditorPushId = useRef<string | null>(null);
  const status = useChatStore((state) => state.status);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopGeneration = useChatStore((state) => state.stopGeneration);
  const selectedModel = useChatStore((state) => state.selectedModel);
  const commands = useChatStore((state) => state.commands);
  const isGenerating = status === "thinking" || status === "streaming";
  const hasModel = Boolean(selectedModel);

  // Mic recording (issue #245): idle -> recording -> saving -> idle. Uses
  // native `getUserMedia`/`MediaRecorder` (no new deps). On stop, the
  // recorded webm blob is base64-encoded and handed to main via
  // `saveRecording`, then an explicit "transcribe and act on this" prompt is
  // pushed into the composer through the same `setValue` seam used above,
  // so the agent treats it as a normal `understand_audio` tool call in
  // conversation context rather than pure dictation echo-back.
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "saving">("idle");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearElapsedTimer();
      stopMediaStream();
    };
  }, [clearElapsedTimer, stopMediaStream]);

  const startRecording = useCallback(async () => {
    setRecordingError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setRecordingError("Mic permission denied");
      return;
    }
    mediaStreamRef.current = stream;
    recordedChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      void handleRecordingStopped();
    };
    recorder.start();
    setRecordingState("recording");
    setElapsedSeconds(0);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRecordingStopped = useCallback(async () => {
    clearElapsedTimer();
    stopMediaStream();
    const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      setRecordingState("idle");
      setRecordingError("Recording was empty");
      return;
    }
    setRecordingState("saving");
    try {
      const base64Audio = await blobToBase64(blob);
      const { path } = await desktopApi().saveRecording(base64Audio, mimeType);
      const pushedText = `Please transcribe and interpret this voice note in the context of our conversation, then act on it: \`${path}\``;
      const textarea = textareaRef.current;
      setValue((current) => {
        const start = textarea?.selectionStart ?? current.length;
        const end = textarea?.selectionEnd ?? current.length;
        return current.slice(0, start) + pushedText + current.slice(end);
      });
      setRecordingState("idle");
    } catch {
      setRecordingState("idle");
      setRecordingError("Failed to save recording");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearElapsedTimer, stopMediaStream]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const toggleRecording = () => {
    setRecordingError(null);
    if (recordingState === "recording") {
      stopRecording();
      return;
    }
    if (recordingState === "idle") {
      void startRecording();
    }
  };

  const isRecording = recordingState === "recording";
  const isSaving = recordingState === "saving";

  // Apply extension-driven `ctx.ui.setEditorText`/`pasteToEditor` pushes
  // (issue #141): "replace" overwrites the composer's content; "paste"
  // inserts at the current cursor position (falling back to appending at
  // the end if no selection range is available, e.g. textarea not focused).
  // `requestId` dedupes so the same push isn't re-applied on every render.
  useEffect(() => {
    if (!lastEditorPush || lastEditorPush.kind !== "set-editor-text") return;
    if (lastEditorPush.requestId === appliedEditorPushId.current) return;
    appliedEditorPushId.current = lastEditorPush.requestId;
    if (lastEditorPush.mode === "replace") {
      setValue(lastEditorPush.text);
      return;
    }
    const pushedText = lastEditorPush.text;
    const textarea = textareaRef.current;
    setValue((current) => {
      const start = textarea?.selectionStart ?? current.length;
      const end = textarea?.selectionEnd ?? current.length;
      return current.slice(0, start) + pushedText + current.slice(end);
    });
  }, [lastEditorPush]);

  // Keep main's cached `getEditorText()` in sync with the real composer
  // value (issue #141). No debounce: this is an in-process IPC call, not a
  // network request, so per-keystroke reporting stays simple (YAGNI).
  useEffect(() => {
    void desktopApi().reportEditorText(value);
  }, [value]);

  // Slash-command autocomplete (ADR 0001 §3.4 Phase 2, issue #91): only
  // shown while the composer's text is a still-being-typed `/name` prefix
  // (no space yet) -- matches pi-coding-agent's own command-name parsing
  // (`AgentSession._tryExecuteExtensionCommand`), so what the list narrows
  // down to is exactly what `session.prompt()` will dispatch on submit.
  const commandMatch = /^\/(\S*)$/.exec(value);
  const matchingCommands =
    commandMatch && commands.length > 0
      ? commands.filter((command) => command.name.startsWith(commandMatch[1]))
      : [];

  // Extension-registered autocomplete providers (issue #140): queried on
  // every non-empty, non-slash-command composer value change. Slash-command
  // prefixes are excluded since the built-in list above already owns that
  // case; extension providers may want much broader matching than the
  // `/^\/(\S*)$/` slash trigger, so we don't try to generalize a shared
  // trigger-pattern system here (YAGNI) -- just skip when a slash command is
  // already being matched.
  useEffect(() => {
    if (!value.trim() || commandMatch) {
      setExtensionSuggestions([]);
      return;
    }
    let cancelled = false;
    void desktopApi()
      .queryAutocomplete(value)
      .then((suggestions) => {
        if (!cancelled) setExtensionSuggestions(suggestions);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const submit = () => {
    if (isGenerating || !value.trim() || !hasModel) return;
    void sendMessage(value);
    setValue("");
  };

  const runCommand = (name: string) => {
    if (isGenerating || !hasModel) return;
    void sendMessage(`/${name}`);
    setValue("");
  };

  return (
    <div className="border-t border-surface-border bg-surface-panel/60 px-6 py-4">
      <div className="relative rounded-2xl border border-surface-border bg-surface-panel px-4 py-3 focus-within:border-accent/50">
        {(matchingCommands.length > 0 || extensionSuggestions.length > 0) && (
          <div className="absolute bottom-full left-0 mb-2 w-full max-w-sm rounded-xl border border-surface-border bg-surface-panel shadow-xl">
            {matchingCommands.map((command) => (
              <button
                key={command.name}
                type="button"
                onClick={() => runCommand(command.name)}
                className="flex w-full flex-col items-start px-4 py-2 text-left text-sm hover:bg-surface-hover"
              >
                <span className="text-white">/{command.name}</span>
                {command.description && <span className="text-xs text-white/50">{command.description}</span>}
              </button>
            ))}
            {extensionSuggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.value}-${index}`}
                type="button"
                onClick={() => setValue(suggestion.value)}
                className="flex w-full flex-col items-start px-4 py-2 text-left text-sm hover:bg-surface-hover"
              >
                <span className="text-white/80">{suggestion.value}</span>
                {suggestion.description && <span className="text-xs text-white/50">{suggestion.description}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Send a message…"
          className="max-h-40 w-full resize-none bg-transparent pr-20 text-sm text-white outline-none placeholder:text-white/30"
        />
        <button
          type="button"
          onClick={toggleRecording}
          disabled={isSaving}
          className={`absolute top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full transition disabled:opacity-30 ${
            isRecording ? "right-12 animate-pulse bg-red-500 text-white" : "right-12 bg-surface-hover text-white hover:bg-surface-hover-strong"
          }`}
          title={
            recordingError ??
            (isRecording ? "Stop recording" : isSaving ? "Saving recording…" : "Record a voice note")
          }
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
        </button>
        {isGenerating ? (
          <button
            type="button"
            onClick={() => void stopGeneration()}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-surface-hover text-white transition hover:bg-surface-hover-strong"
            title="Stop generation"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || !hasModel || isRecording}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-black transition disabled:opacity-30"
            title={hasModel ? "Send" : "Select a model to start chatting"}
          >
            <Send size={14} />
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {recordingError ? (
          <p className="text-[11px] text-red-400">{recordingError}</p>
        ) : isRecording ? (
          <p className="text-[11px] text-red-400">Recording… {elapsedSeconds}s</p>
        ) : (
          <p className="text-[11px] text-white/30">Enter to send · Shift+Enter for newline</p>
        )}
        <ModelPicker />
      </div>
    </div>
  );
}
