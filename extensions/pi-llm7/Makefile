SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install build test lint check clean pack publish

## Show available targets
help:
	@echo "Available targets:"
	@echo "  make install  Install dependencies for this package"
	@echo "  make build    Compile src -> dist (tsc)"
	@echo "  make test     Run this package's tests"
	@echo "  make lint     Type-check this package (alias: check)"
	@echo "  make check    Alias for lint"
	@echo "  make clean    Remove dist/"
	@echo "  make pack     npm pack --dry-run"
	@echo "  make publish  Publish to npm (currently blocked, see below)"

## Install dependencies (run from repo root workspace install normally;
## this target lets the package be worked on standalone too).
install:
	npm install

## Compile src -> dist
build:
	npm run build

## Run this package's tests
test:
	npm test

## Type-check this package
lint:
	npx tsc --noEmit -p tsconfig.json

## Alias for lint, kept for convention parity with the root Makefile
check: lint

## Remove build output
clean:
	npm run clean

## Dry-run what would be published in the npm tarball
pack:
	npm pack --dry-run

## Publish to npm.
## NOTE: currently blocked on npm MFA for the @pi-desktop scope (see #194)
## -- this target intentionally does not implement any auth flow. Run
## manually once publish access is set up: `npm publish --access public`.
publish:
	npm publish --access public
