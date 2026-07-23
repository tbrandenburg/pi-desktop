export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-white/40">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      Thinking…
    </div>
  );
}
