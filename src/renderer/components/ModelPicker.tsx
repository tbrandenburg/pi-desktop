import { ChevronDown } from "lucide-react";
import { useChatStore } from "../state/chat-store";
import { CREDENTIAL_GATED_HINT, missingCredentialGatedProviders } from "../lib/credential-gated-providers";
import type { ModelInfo } from "../../shared/events";

/**
 * Resolves a model's single most-informative status glyph + tooltip for the
 * three-tier model availability signal (issue #175), per the precedence
 * "verified (tier 3)" > "reachability (tier 2)" > "configured (tier 1)" >
 * unknown. Native `<option>` elements can't render rich icons/markup, so
 * this returns a plain-text prefix symbol plus an accessible `title`.
 */
function modelStatus(model: ModelInfo): { symbol: string; title: string } {
  if (model.verified?.lastResult === "ok") {
    return { symbol: "\u2713", title: "Last used successfully" };
  }
  if (model.verified?.lastResult === "error") {
    // Tier 3 real-use evidence about THIS check must stay visible even if
    // Tier 2 currently reports the provider reachable -- a transient probe
    // success does not erase a recorded real failure.
    const reachableNote = model.reachability === "reachable" ? " (provider currently reachable)" : "";
    return { symbol: "\u26a0", title: `Last use failed${reachableNote}` };
  }
  switch (model.reachability) {
    case "reachable":
      return { symbol: "\u25cf", title: "Provider reachable" };
    case "auth-failed":
      return { symbol: "\u26bf", title: "Provider needs re-authentication" };
    case "unreachable":
      return { symbol: "\u2715", title: "Provider unreachable" };
    case "checking":
      return { symbol: "\u2026", title: "Checking provider availability\u2026" };
    default:
      break;
  }
  if (!model.configured) {
    return { symbol: "\u25cb", title: "Provider not configured \u2014 add credentials in Settings" };
  }
  return { symbol: "", title: "Not yet checked" };
}

/**
 * Formats a model's context window size for compact inline display in a
 * native `<option>` label (issue #178) -- e.g. `128000` -> `"128K"`,
 * `1000000` -> `"1M"`. Native `<option>`s can't render rich markup, so this
 * stays plain text, following the same inline-text precedent as the status
 * symbol above.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return `${tokens}`;
}

export function ModelPicker() {
  const models = useChatStore((state) => state.models);
  const selectedModel = useChatStore((state) => state.selectedModel);
  const selectModel = useChatStore((state) => state.selectModel);
  const hasModels = models.length > 0;
  const gatedProviderIds = missingCredentialGatedProviders(models.map((model) => model.id));

  return (
    <div className="relative opacity-50 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100">
      <select
        value={hasModels ? selectedModel : ""}
        onChange={(event) => selectModel(event.target.value)}
        disabled={!hasModels}
        className="appearance-none rounded-lg border border-surface-border bg-surface-panel py-1.5 pl-3 pr-8 text-xs text-white/80 outline-none disabled:cursor-not-allowed disabled:text-white/40"
      >
        {hasModels ? (
          models.map((model) => {
            const status = modelStatus(model);
            const contextSuffix =
              model.contextWindow !== undefined ? ` \u2014 ${formatContextWindow(model.contextWindow)} ctx` : "";
            const label = `${model.label}${contextSuffix}`;
            return (
              <option key={model.id} value={model.id} title={status.title}>
                {status.symbol ? `${status.symbol} ${label}` : label}
              </option>
            );
          })
        ) : (
          <option value="">No models available</option>
        )}
        {gatedProviderIds.length > 0 ? (
          <optgroup label="Not configured">
            {gatedProviderIds.map((providerId) => (
              <option key={providerId} value="" disabled>
                {`${providerId} (${CREDENTIAL_GATED_HINT})`}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40"
      />
    </div>
  );
}
