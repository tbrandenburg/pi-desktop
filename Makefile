SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install run stop test lint check build build-renderer build-main clean \
        dist dist-linux dist-win pack

## Show available targets
help:
	@echo "Available targets:"
	@echo "  make install     Install all dependencies"
	@echo "  make run         Start app in dev mode (renderer + main + electron)"
	@echo "  make stop        Kill any running dev/electron processes"
	@echo "  make test        Run unit tests (vitest)"
	@echo "  make lint        Type-check the renderer and main process"
	@echo "  make build       Build renderer + main for production"
	@echo "  make pack        Build and package app dir (no installer, fast local check)"
	@echo "  make dist        Build and package installers for the current platform"
	@echo "  make dist-linux  Build and package Linux AppImage"
	@echo "  make dist-win    Build and package Windows installer (nsis + portable)"
	@echo "                   Requires 'wine' when cross-building from Linux."
	@echo "  make clean       Remove build artifacts (dist-*, release, node_modules)"

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

## Run all tests
test:
	npm run test

## Type-check code (renderer + main)
lint:
	npm run check

## Alias for lint (type-check), kept for convention parity
check: lint

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

## Remove build artifacts
clean:
	rm -rf dist-main dist-renderer release
	rm -rf node_modules
