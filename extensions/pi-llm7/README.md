# @pi-desktop/pi-llm7

An optional-key [LLM7](https://llm7.io) provider for
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Works with
**no credential at all**, and uses a real key when you have one.

Registers provider id **`llm7-free`** with two free routing selectors:

| Model | Description | Cost |
| --- | --- | --- |
| `default` | first available free model | free |
| `fast` | lowest-latency free option | free |

The paid `pro` selector is intentionally not exposed.

## Install

```bash
pi install npm:@pi-desktop/pi-llm7
```

> **Scope availability note:** `@pi-desktop` was confirmed unclaimed as of
> 2026-08-10 (`npm view @pi-desktop/pi-llm7` returns 404). Re-check this
> immediately before the actual publish — if the scope is unusable at publish
> time (e.g. an org-creation issue or policy problem), the documented fallback
> package name is `@tbrandenburg/pi-llm7`.

## Optional key

No configuration is required — llm7.io serves anonymous requests. If you do have
a key, set `LLM7_API_KEY` and it is used instead of the anonymous placeholder:

```bash
export LLM7_API_KEY=<your token>
```

The key is never allowed to resolve to an empty value (see below).

## The `pi-free` bug this fixes

`pi-free` also ships an LLM7 provider, but its `auth.resolve()` deliberately
returns *empty* auth when no key is configured. `pi-ai`'s `openai-completions`
transport (`getClientApiKey()`) throws unless `apiKey` is a **non-empty string**,
so `pi-free`'s LLM7 models show up in the picker and then hard-fail at send time
with:

```
No API key for provider: llm7
```

llm7.io itself does not validate the key, so this package simply sends a
non-empty placeholder (`"anonymous"`) whenever no real key is configured. The
provider id is `llm7-free` (not `llm7`) so it can coexist with `pi-free` and with
any personal `models.json` `llm7` override without a silent id collision.

## Smoke test your install

```bash
pi --no-extensions -e ./dist/index.js -p --no-session \
   --provider llm7-free --model default "Reply with exactly: PONG"
```

Expected: `PONG` on stdout, exit code `0`.

## Note on the context window

The catalog advertises a 128K context window rather than `pi-free`'s 32K. With
32K, pi's own system prompt (~28K tokens) leaves ~1 token of output budget and
every reply comes back truncated (`stopReason: "length"`, empty stdout). The
upstream models LLM7 routes to are far larger than 32K.

## Development

```bash
make -C extensions/pi-llm7 install
make -C extensions/pi-llm7 build
make -C extensions/pi-llm7 test
make -C extensions/pi-llm7 lint
```

## Publishing

Real `npm publish` is not yet performed for this package (npm MFA for the
`@pi-desktop` org has not been set up). Once resolved:

```bash
npm login
npm publish -w extensions/pi-llm7 --access public   # run from repo root
```

**Version-bump policy:** this package follows its own independent semver,
tracked only in `extensions/pi-llm7/package.json`. There is no automatic
CI publish-on-tag in this first iteration — publishing is manual only, and
is not coupled to the app's own `make release-patch`/`version-*` targets
(those version and release `pi-desktop` itself, not this extension).
Revisit automation once there is a second extension to justify the shared
tooling.

