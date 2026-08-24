# @pi-desktop/pi-multimedia

First-party pi extension, bundled with pi-desktop (see
`electron-builder.yml`'s `extraResources`), registering `understand_audio`
and `understand_video` tools so a chat session can understand local audio
and video files. pi-ai's `Message` schema (as of
`@earendil-works/pi-ai@0.84.1`) has no `AudioContent`/`VideoContent` block
type, so both tools bypass that schema entirely and make a raw HTTP call to a
chat completions API directly from `execute()`, returning the answer as a
plain `TextContent` tool result block — which fits the existing
`AgentToolResult<TDetails>` contract unchanged. See issue #234 for the full
design rationale and live-verification history.

## Tool: `understand_audio`

| Param | Required | Description |
| --- | --- | --- |
| `path` | yes | Path to a local `.wav`/`.mp3`/`.m4a` file |
| `prompt` | no | Unused. Kept in the schema only for backward compatibility (issue #260) — never read or forwarded anywhere. |

The actual network call is behind an injectable `fetchFn` so `src/audio.ts`
is fully unit-testable without ever hitting the network (see `src/audio.test.ts`).

### Transcription-only, fixed fallback chain (issue #260)

`understand_audio` is transcription-only: every call transcribes the audio
and returns plain text. There is no prompt-driven branch — `prompt` has no
effect on chain selection or request content.

A single, fixed, ordered candidate chain is tried until one succeeds:

1. Explicit env override: `MULTIMEDIA_TRANSCRIBE_MODEL` +
   `MULTIMEDIA_AUDIO_API_KEY`/`MULTIMEDIA_AUDIO_BASE_URL` — if set, trusted
   and discovery is skipped entirely.
2. OpenRouter — `gpt-4o-mini-transcribe`, then `whisper-1`
   (`/audio/transcriptions`).
3. Groq — `whisper-large-v3` (`/audio/transcriptions`).
4. OpenAI — `gpt-4o-mini-transcribe`, then `whisper-1`
   (`/audio/transcriptions`).
5. OpenRouter — `openai/gpt-audio`, sent as a `/chat/completions` request
   with `modalities: ["text"]` and a dedicated transcription-only prompt
   (never the tone/emotion-oriented `AUDIO_UNDERSTANDING_SYSTEM_PROMPT`).
6. OpenAI (native `api.openai.com`) — `openai/gpt-audio`, same request
   shape as candidate 5, always forced to `api.openai.com` regardless of
   any registry-configured base URL override.

Credentials for candidates 2-6 are resolved per-provider via
`ctx.modelRegistry.getProviderAuthStatus`/`getApiKeyForProvider` — **not**
whether a matching model appears in `getAvailable()`, since transcription
models like `whisper-1` are never listed there.

This reorders the pre-#260 chain, which tried OpenAI first, then
OpenRouter, then Groq, and stopped at candidate 1 (equivalent to today's
candidates 2/4 combined). OpenAI moves from position 1 to position 3.

**Exhaustive retry (issue #260):** the chain never stops early on an
authentication failure, rate limit, or network error — it always tries every
remaining candidate. Only a parse failure (malformed response body) is a
real code/contract bug and surfaces immediately instead of being retried.
The shared, typed skip-reason vocabulary is:

- `no-credential` — no resolved credential for that provider (pre-call skip).
- `model-not-found` — HTTP 400 (provider doesn't recognize the model).
- `auth-failed` — HTTP 401.
- `rate-limited` — HTTP 429.
- `network-error` — no HTTP response at all (fetch-level failure).

On full exhaustion (every candidate skipped), one clear tool error is
returned (never a raw 401/429), naming every candidate tried and why.

Set `PI_MULTIMEDIA_DEBUG=1` for structured, one-line-per-candidate debug
logging to stderr (off by default), showing every candidate's specific
reason in order:

```
[pi-multimedia] chain=audio candidate=1/7 provider=openrouter model=gpt-4o-mini-transcribe result=skip reason=no-credential
[pi-multimedia] chain=audio candidate=2/7 provider=openrouter model=whisper-1 result=skip reason=no-credential
[pi-multimedia] chain=audio candidate=3/7 provider=groq model=whisper-large-v3 result=success
```

## Tool: `understand_video`

| Param | Required | Description |
| --- | --- | --- |
| `path` | yes | Path to a local video file (e.g. `.mp4`) |
| `prompt` | no | What to ask about the video (default: describe what happens) |
| `frameCount` | no | How many evenly-spaced frames to extract via `ffmpeg` (default: 3) |

Frame extraction shells out to a real local `ffmpeg`/`ffprobe` (via
`child_process`) — this is a real subprocess call, not something to mock
away. Extracted JPEG frames are base64-encoded and sent as one
`image_url` data-URI content block per frame alongside the text prompt, in a
single chat-completions request to a vision-capable model. The HTTP call
itself is behind the same injectable `fetchFn` pattern as `understand_audio`,
so `src/video.ts`'s network-calling code is unit-tested without hitting the
network, while frame extraction is exercised against a real, on-the-fly
generated synthetic test video (see `src/video.test.ts`).

**Live-verified (2026-08-22)** against the real OpenAI API using a real 5s
1920x1080 sample clip: `ffmpeg` extracted 3 real JPEG frames (~730-790KB
base64 each), and `gpt-5.6` (the first model tried) correctly described the
scene (a park with a bench/path next to a road with passing cars/buses) from
the extracted frames alone — confirming the model genuinely saw video
content. Malformed inputs (a non-existent path, and a frame count implying
sub-second spacing beyond what ffmpeg could decode near the end of the clip)
both degrade to `isError: true` instead of throwing.

## Configuration

`understand_audio`'s resolution is described above (fixed fallback chain,
issue #260). `understand_video` keeps the older, simpler two-step
resolution: a registry name-hint match first, then env var fallback.

| Variable | Purpose |
| --- | --- |
| `MULTIMEDIA_AUDIO_API_KEY` | API key for `understand_audio`'s env-override candidate |
| `MULTIMEDIA_AUDIO_BASE_URL` | Optional override of the audio API base URL (env-override candidate) |
| `MULTIMEDIA_TRANSCRIBE_MODEL` | Explicit chain-override model (skips the fixed provider chain entirely) |
| `MULTIMEDIA_VIDEO_API_KEY` | API key for `understand_video` |
| `MULTIMEDIA_VIDEO_BASE_URL` | Optional override of the video/vision API base URL |
| `MULTIMEDIA_VIDEO_MODEL` | Overrides the vision model/search hint (default `gpt-4o`) |
| `PI_MULTIMEDIA_DEBUG` | Set to `1` for structured per-candidate debug logging (see above) |

Without a key resolved via either path, `execute()` returns a normal
`isError` tool result (never throws) explaining the missing configuration.
`understand_video` additionally requires a local `ffmpeg`/`ffprobe` binary
on `PATH`.

See issue #235 for the design rationale behind preferring registry reuse
over a dedicated new Settings UI page, and issue #260 for the
transcription-only, fixed fallback-chain design (superseding issue #243's
transcription-vs-understanding split).

## Known limitations

- `.m4a` files are labeled `mp3` for the API's `format` field without an
  actual transcode; a future version would transcode m4a -> wav/mp3 first.
- Large base64 audio/frame payloads remain in the tool-result/conversation
  history across turns, which can bloat context; a future version should
  summarize/prune the raw base64 fields from history after the model has seen
  them once. This is more pronounced for video: N frames means N images per
  call versus 1 audio payload per call, multiplying both request payload size
  and per-call cost.
- Requesting a very high frame count on a short clip is clamped upfront to
  the real ffprobe-measured safe maximum (see `computeMaxSafeFrameCount` in
  `src/video.ts`), with a note prepended to the result text rather than
  failing — verified live against real ffmpeg boundary behavior.
- Automatic retry/backoff on HTTP 429 is not implemented; 429 responses are
  surfaced as an informative error only (see `buildErrorMessage` in
  `src/audio.ts`/`src/video.ts`).

