import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PackageInfo } from "../../shared/events";
import { desktopApi } from "../lib/desktop-api";
import { useSettingsStore } from "../state/settings-store";

export function SettingsDialog() {
  const isOpen = useSettingsStore((state) => state.isOpen);
  const close = useSettingsStore((state) => state.close);

  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const refresh = () => {
    void desktopApi()
      .listPackages()
      .then(setPackages)
      .catch(() => setPackages([]));
  };

  useEffect(() => {
    if (isOpen) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handleInstall = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setError(null);
    setInstalling(true);
    try {
      // `installPackage` blocks on the real, mandatory trust prompt
      // (ADR 0001 §3.7) -- this call only resolves once the user has
      // answered it.
      await desktopApi().installPackage(trimmed);
      setSource("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleRemove = async (pkgSource: string) => {
    await desktopApi().removePackage(pkgSource);
    refresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button type="button" onClick={close} className="text-white/50 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold text-white">Packages</h3>
          <p className="mb-2 text-xs text-white/60">
            Install a local-path or git pi-package. Third-party package code runs with full
            system access -- you will be asked to explicitly trust each package before it runs.
          </p>

          <div className="mb-2 flex gap-2">
            <input
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="git:github.com/user/repo or /path/to/package"
              className="flex-1 rounded-lg border border-surface-border bg-black/20 px-2 py-1 text-sm text-white placeholder:text-white/40"
            />
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing || !source.trim()}
              className="rounded-lg bg-accent px-3 py-1 text-sm font-medium text-black disabled:opacity-50"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          </div>

          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

          {packages.length === 0 ? (
            <p className="text-xs text-white/50">No packages installed.</p>
          ) : (
            <ul className="space-y-1">
              {packages.map((pkg) => (
                <li
                  key={pkg.source}
                  className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1 text-xs text-white/80"
                >
                  <span className="truncate" title={pkg.source}>
                    {pkg.source}
                    {!pkg.trusted && <span className="ml-2 text-amber-400">(untrusted)</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemove(pkg.source)}
                    className="ml-2 shrink-0 text-white/50 hover:text-white"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
