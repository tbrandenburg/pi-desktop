/**
 * Placeholder extension factory for the pi-llm7 pi-package (issue #191).
 *
 * Real provider registration logic lands in a later issue (#192/#193) --
 * this trivial no-op factory only exists to prove the extensions workspace
 * scaffold (package.json manifest, tsconfig, build pipeline) end-to-end
 * before any real logic is added.
 */
export default function piLlm7(_pi: unknown): void {
  // Intentionally empty -- see #192/#193 for real registration logic.
}
