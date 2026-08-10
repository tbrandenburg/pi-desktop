export interface RecommendedPackage {
  /** Exact source string passed to installPackage(source) -- e.g. "npm:pi-web-access". */
  source: string;
  name: string;
  description: string;
}

export const RECOMMENDED_PACKAGES: readonly RecommendedPackage[] = [
  {
    source: "npm:pi-web-access",
    name: "pi-web-access",
    description: "Web search and page-fetch tools for the agent.",
  },
];
