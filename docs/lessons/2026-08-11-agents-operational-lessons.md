# AGENTS.md Archive: Operational and Coordination Lessons

This archive preserves the detailed incident narratives removed from `AGENTS.md`
under issue #215. The rules in `AGENTS.md` are the operational reference.

## Reconnaissance and validation

Parallel subagents repeatedly found that stale issue descriptions overstated what
was missing. Reading current source, tests, and history before dispatching avoided
unnecessary work. When subagents worked in isolated in-repo worktrees, coordinator
integration still required clean-state validation because stale dependencies and
worktree build output hid install and coverage failures.

Batch independent read-only searches and reads before editing. After green
subagent validation, do not repeat every test by habit: run the exact CI gates and
the acceptance path that adds independent evidence. Full duplicate validation can
create duration and resource regressions without increasing confidence.

When a subagent test needs a decoupled directory, fixture, mock, or other
workaround, investigate what production branch the workaround disables. A shared
config directory once caused a resource loader to see every settings package;
the artificial test isolation hid the trust/configuration bug until the real
library path was traced.

When a registry or configuration is constructed in more than one place, compare
all arguments and exercise the actual production call shape. A picker registry
received bundled extensions while ChatService built a second registry with no
context, so a listed model failed on send. A keyless provider also hit an
independent API-key guard; fixing one blocker did not prove the turn worked.

## Install, CI, and quality gates

`npm install --package-lock-only` was not a deterministic drift test because npm
resolved optional wasm dependencies differently by context. Later, even clean
local installs differed from CI for floating `@emnapi/*` ranges under optional
platform packages. Exact `overrides` were needed; use clean installs twice when
optional platform dependencies change and use `npm ci` as the CI-equivalent gate.

The CI workflow's job context differed from the branch-protection context, making
green checks appear blocked. The fix was to inspect both GitHub API responses and
retarget protection to the actual `check-and-test` context. A separate PR had no
Actions run at all; an admin merge was justified only after reproducing the exact
CI commands from a clean clone.

Coverage once printed `Unknown% (0/0)` while the ratchet exited successfully. A
green exit code was not evidence that the gate measured anything; inspect measured
values and fail vacuous reports. The exact CI command was `make test`, not plain
`npm test`, because the Make target enforced test-duration limits. Expensive real
sessions inflated unrelated per-file windows; sharing immutable setup restored the
baseline instead of raising thresholds.

## Worktrees and parallel changes

Split parallel work by file ownership, not merely by logical issue. Put same-file
changes in one package, sequence hard type dependencies, and remove worktrees
before repo-wide coverage scans. A symlinked root `node_modules` was safe for
type-checking, tests, and lint but broke electron-builder dependency walking;
package only from a worktree with real dependencies and treat `@undefined`
warnings as failures.

After interrupted work, inspect `git status` and `git log` before concluding that
the work was lost. Compare branches with read-only `git diff`; never use
`git checkout <other-branch> -- .`, which overwrites every differing path.

## Release and GitHub tooling

electron-builder can exit zero while silently skipping uploads when the existing
release type conflicts with its configured type. Check the actual release assets,
not only the job status. CLI architecture flags can also override YAML: macOS
needed an explicit `--universal`, confirmed by the build log and asset filename.

PR issue references must use `Closes #N`, `Fixes #N`, or `Resolves #N` directly;
plain bullets do not auto-close issues. Verify issue state after merge. Backtick
content in shell-passed GitHub bodies triggered command substitution; use safe
quoting or a body file and re-fetch the posted content.

## Further operational findings

Environment overrides passed through a detached AppImage were not trusted until
verified by cwd or observable behavior. Chromium process environments could not
be read directly, so behavior was the useful control. Never rely on a positive
observation when two candidate paths can explain it.

The bundled extension loader had to remain a strict superset of the library
default; following a contradictory acceptance phrase literally would have disabled
user packages. Validate issue criteria against current library semantics before
changing behavior. A model appearing in a picker proves only listing, never
serving; always complete one real turn.

The packaged application can keep running after a shell timeout, and a second
launch can silently target the first process through Electron's single-instance
lock. Inspect the debug port owner before every retry.
