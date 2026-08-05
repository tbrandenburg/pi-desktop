SHELL := /bin/bash
.DEFAULT_GOAL := help

# Recursively (lazily) expanded: re-reads package.json on every reference, so
# it reflects the version *after* a version-bump target has just run it,
# even within the same `make` invocation (e.g. `make release-patch`).
VERSION = $(shell node -p "require('./package.json').version")

.PHONY: help install run stop test lint check audit build build-renderer build-main clean \
        dist dist-linux dist-win dist-mac pack \
        run-bundled run-linux run-win run-mac \
        version-patch version-minor version-major release publish \
        release-patch release-minor release-major

## Show available targets
help:
	@echo "Available targets:"
	@echo "  make install     Install all dependencies"
	@echo "  make run         Start app in dev mode (renderer + main + electron)"
	@echo "  make stop        Kill any running dev/electron processes"
	@echo "  make test        Run unit tests (vitest); warns if suite takes >60s"
	@echo "  make lint        Type-check renderer + main; runs oxlint; warns on files >500 LOC and test:source LOC ratio >2:1; fails on coverage regression below .coverage-baseline"
	@echo "  make audit       Audit dependencies for known vulnerabilities"
	@echo "  make build       Build renderer + main for production"
	@echo "  make pack        Build and package app dir (no installer, fast local check)"
	@echo "  make dist        Build and package installers for the current platform"
	@echo "  make dist-linux  Build and package Linux AppImage"
	@echo "  make dist-win    Build and package Windows installer (nsis + portable)"
	@echo "                   Requires 'wine' when cross-building from Linux."
	@echo "  make dist-mac    Build and package macOS dmg + zip (universal, unsigned)"
	@echo "                   Must run on real macOS hardware (no cross-build path)."
	@echo "                   Unsigned: end users must right-click > Open past Gatekeeper."
	@echo "  make clean       Remove build artifacts (dist-*, release, node_modules)"
	@echo "  make run-bundled Run the already-built app for the current host platform"
	@echo "                   (best-effort: picks whatever's newest in release/)"
	@echo "  make run-linux   Run the built Linux AppImage directly"
	@echo "  make run-win     Run the built Windows app (native .exe, or via"
	@echo "                   'wine' when cross-running from Linux/macOS)"
	@echo "  make run-mac     Run the built macOS app (macOS only)"
	@echo "  make version-patch/-minor/-major"
	@echo "                   Bump version (package.json + package-lock.json),"
	@echo "                   commit 'chore(release): vX.Y.Z' and git tag it"
	@echo "  make release     Push the release commit + tag to origin"
	@echo "  make publish     Create the GitHub release for the current tag"
	@echo "                   (release notes only; the Release Actions workflow"
	@echo "                   attaches the Linux AppImage + Windows portable exe"
	@echo "                   once 'make release' pushes the tag)"
	@echo "  make release-patch/-minor/-major"
	@echo "                   One-shot: bump + push + publish (tag push also"
	@echo "                   triggers the Release Actions workflow's builds)"

## Install all dependencies
install:
	npm install

## Start service in dev mode
run:
	npm run dev

## Stop any running dev/electron processes started by 'make run'
stop:
	-pkill -f "vite" 2>/dev/null || true
	-pkill -f "tsc -p tsconfig.main.json -w" 2>/dev/null || true
	-pkill -f "scripts/run-electron-dev.ts" 2>/dev/null || true
	-pkill -f "electron \." 2>/dev/null || true

## Run all tests (warns if suite exceeds 60s, but never fails on slowness alone)
test:
	@start=$$(date +%s); \
	npm run test; \
	status=$$?; \
	end=$$(date +%s); \
	elapsed=$$((end - start)); \
	if [ $$elapsed -gt 60 ]; then \
		echo "WARNING: test suite took $${elapsed}s (threshold: 60s)"; \
	fi; \
	exit $$status

## Type-check code (renderer + main); runs oxlint; also warns on source files
## over 500 LOC and on test files that exceed 500 LOC or a 2:1 test:source LOC ratio
lint:
	npm run check
	npm run lint:oxlint
	@find src \( -name "*.ts" -o -name "*.tsx" \) | grep -Ev '\.test\.' | xargs wc -l | grep -v ' total$$' | awk '$$1>500{print "WARNING: " $$2 " has " $$1 " lines"}'
	npm run check:test-ratio
	npm test -- --coverage
	bash scripts/check-coverage-ratchet.sh

## Alias for lint (type-check), kept for convention parity
check: lint

## Audit dependencies for known vulnerabilities
## Scoped to production dependencies only (--omit=dev): devDependencies here
## are build-time-only tooling (electron-builder and its transitive deps)
## that is never bundled into the shipped app, so vulnerabilities in them
## carry no runtime risk to end users. Auditing them anyway would fail the
## build on issues nobody can act on without vendor upstream fixes.
audit:
	npm audit --audit-level=high --omit=dev

## Build renderer + main for production
build:
	npm run build

build-renderer:
	npm run build:renderer

build-main:
	npm run build:main

## Package app directory without creating an installer (fast local verification)
pack: build
	npx electron-builder --dir

## Build installers for the current host platform
dist: build
	npx electron-builder

## Build Linux AppImage
dist-linux: build
	npx electron-builder --linux AppImage

## Build Windows installer (nsis) + portable exe.
## Cross-building from Linux requires 'wine' (and 'mono' for some installers):
##   sudo apt-get install wine mono-complete
dist-win: build
	@command -v wine >/dev/null 2>&1 || { \
		echo "error: 'wine' is required to build Windows targets from Linux."; \
		echo "Install it first, e.g.: sudo apt-get install wine mono-complete"; \
		exit 1; \
	}
	npx electron-builder --win nsis portable --x64

## Build macOS dmg + zip (universal, unsigned). Must run on real macOS
## hardware -- unlike Windows/wine, there is no cross-build path for mac.
dist-mac: build
	@[ "$$(uname -s)" = "Darwin" ] || { \
		echo "error: 'make dist-mac' must run on real macOS hardware (uname -s != Darwin)."; \
		echo "This target has no cross-build path (unlike dist-win via wine)."; \
		exit 1; \
	}
	npx electron-builder --mac dmg zip --universal

## Remove build artifacts
clean:
	rm -rf dist-main dist-renderer release
	rm -rf node_modules

## --- Run the already-built (bundled) app ----------------------------------
##
## Convenience-only: these never build anything themselves (run `make
## dist-linux`/`dist-win` first) and are best-effort about locating the
## artifact, since electron-builder's exact filename varies by version/arch
## (e.g. AppImage names use "x86_64", not "x64"). They just pick the most
## recently built matching file under release/.

## Run whatever was built for the current host platform (Linux or Windows)
run-bundled:
	@case "$$(uname -s)" in \
		Linux*) $(MAKE) run-linux ;; \
		MINGW*|MSYS*|CYGWIN*) $(MAKE) run-win ;; \
		Darwin*) $(MAKE) run-mac ;; \
		*) echo "error: unsupported host platform for 'make run-bundled': $$(uname -s)"; \
		   echo "Run 'make run-linux', 'make run-win', or 'make run-mac' explicitly instead."; \
		   exit 1 ;; \
	esac

## Run the built Linux AppImage (make dist-linux must have run first).
## --no-sandbox is required in many dev containers/CI images where the
## bundled chrome-sandbox helper isn't installed setuid-root, and
## --disable-gpu avoids a GPU-process crash-loop on headless/software-
## rendered X11 displays (VMs, containers, remote desktops) -- a real
## desktop install typically doesn't need either, but both are harmless
## there too (just software rendering instead of hardware-accelerated).
run-linux:
	@appimage=$$(ls -t release/*.AppImage 2>/dev/null | head -n1); \
	if [ -z "$$appimage" ]; then \
		echo "error: no .AppImage found under release/. Run 'make dist-linux' first."; \
		exit 1; \
	fi; \
	chmod +x "$$appimage"; \
	echo "Running: $$appimage"; \
	"$$appimage" --no-sandbox --disable-gpu

## Run the built Windows app (make dist-win must have run first).
## Prefers the unpacked win-unpacked/*.exe (fastest, no installer prompts);
## falls back to the portable exe, then the nsis installer exe. Runs
## natively if already on Windows, otherwise via 'wine' (best-effort).
run-win:
	@exe=$$(ls -t release/win-unpacked/*.exe 2>/dev/null | head -n1); \
	if [ -z "$$exe" ]; then \
		exe=$$(ls -t release/*portable*.exe 2>/dev/null | head -n1); \
	fi; \
	if [ -z "$$exe" ]; then \
		exe=$$(ls -t release/*setup*.exe 2>/dev/null | head -n1); \
	fi; \
	if [ -z "$$exe" ]; then \
		echo "error: no Windows .exe found under release/. Run 'make dist-win' first."; \
		exit 1; \
	fi; \
	case "$$(uname -s)" in \
		MINGW*|MSYS*|CYGWIN*) \
			echo "Running: $$exe"; \
			"$$exe" ;; \
		*) \
			command -v wine >/dev/null 2>&1 || { \
				echo "error: 'wine' is required to run a Windows .exe from $$(uname -s)."; \
				echo "Install it first, e.g.: sudo apt-get install wine mono-complete"; \
				exit 1; \
			}; \
			echo "Running via wine: $$exe"; \
			wine "$$exe" ;; \
	esac

## Run the built macOS app (make dist-mac must have run first, on macOS).
run-mac:
	@[ "$$(uname -s)" = "Darwin" ] || { \
		echo "error: 'make run-mac' requires macOS ('open' is macOS-only)."; \
		exit 1; \
	}
	@app=$$(ls -td release/mac-universal/*.app release/mac/*.app 2>/dev/null | head -n1); \
	if [ -z "$$app" ]; then \
		echo "error: no .app found under release/. Run 'make dist-mac' first."; \
		exit 1; \
	fi; \
	echo "Running: $$app"; \
	open "$$app"

## --- Versioning & release -------------------------------------------------
##
## Version bumps always run `npm run check` + `npm test` first (never tag a
## broken commit), then `npm version <bump>`, which updates package.json +
## package-lock.json, commits "chore(release): vX.Y.Z", and creates the
## matching annotated git tag "vX.Y.Z" — all locally, nothing pushed yet.

## Bump patch version (0.1.0 -> 0.1.1): commit + git tag, no push
version-patch: check test
	npm version patch -m "chore(release): v%s"

## Bump minor version (0.1.0 -> 0.2.0): commit + git tag, no push
version-minor: check test
	npm version minor -m "chore(release): v%s"

## Bump major version (0.1.0 -> 1.0.0): commit + git tag, no push
version-major: check test
	npm version major -m "chore(release): v%s"

## Push the current release commit and its version tag to origin.
## Pushing the tag triggers .github/workflows/release.yml, which builds and
## attaches the Linux AppImage and Windows portable exe to the release
## (asynchronously, alongside/after `make publish` below).
release:
	git push origin HEAD
	git push origin "v$(VERSION)"

## Create the GitHub release for the current version's tag (notes only).
## CI (.github/workflows/release.yml) attaches the Linux AppImage and
## Windows portable exe build artifacts automatically once the matching
## tag is pushed -- no local dist-linux/dist-win step is required for that.
publish:
	@command -v gh >/dev/null 2>&1 || { \
		echo "error: 'gh' (GitHub CLI) is required to publish a release."; \
		exit 1; \
	}
	gh release create "v$(VERSION)" --title "v$(VERSION)" --generate-notes

## One-shot release flows: bump -> push -> publish. The tag push triggers
## CI to build and attach the AppImage/portable exe artifacts automatically.
release-patch: version-patch release publish
release-minor: version-minor release publish
release-major: version-major release publish
