# @pi-desktop/pi-llm7

First-party pi-package scaffold for pi-desktop's LLM7 provider integration.

This is currently a placeholder (see issue #191) that proves the
`extensions/*` npm-workspaces build pipeline end-to-end. Real provider
registration logic will land in a follow-up issue.

## Development

```bash
make -C extensions/pi-llm7 install
make -C extensions/pi-llm7 build
make -C extensions/pi-llm7 test
make -C extensions/pi-llm7 lint
```
