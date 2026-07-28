# Security Policy

Pi Desktop is a young, actively-developed project. There is no formal bug
bounty program.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities
(e.g. credential leakage, sandbox escape, path traversal, RCE via a
malicious model/tool response).

Instead, report it privately via [GitHub Security Advisories](https://github.com/tbrandenburg/pi-desktop/security/advisories/new)
for this repository. If that's not available, contact the maintainer
directly through their GitHub profile.

Include:
- Steps to reproduce
- Affected version (from the app or the release/AppImage filename)
- Impact assessment (what an attacker could do)

## Scope

Relevant areas given this app's architecture (see `AGENTS.md`):
- Renderer ⇄ main process IPC boundary (`src/preload`)
- Credential handling (`src/main/llm`, `settings-store`)
- Agent tool execution (filesystem/shell tools under `src/main/agent`)

## Response

This is currently a single-maintainer project. Expect an initial response
within a few days, not guaranteed SLAs. Confirmed vulnerabilities will be
fixed and disclosed via the release notes once a patch is available.
