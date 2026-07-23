export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mx-6 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
      {message}
    </div>
  );
}
