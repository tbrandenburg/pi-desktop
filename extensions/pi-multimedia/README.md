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
| `prompt` | no | What to ask about the audio (default: plain transcription; a prompt switches to audio-understanding — see below) |

The actual network call is behind an injectable `fetchFn` so `src/audio.ts`
is fully unit-testable without ever hitting the network (see `src/audio.test.ts`).

### Transcription vs. understanding, and candidate chains (issue #243)

`understand_audio` no longer takes a `mode` parameter. Instead, behavior is
inferred from whether `prompt` is given:

- **No `prompt`** — the user wants words. The **transcription chain** is
  tried first (cheap speech-to-text via a dedicated `/audio/transcriptions`
  endpoint). Only if zero transcription candidates are resolvable at all
  does it fall back to the **understanding chain** with a default
  "transcribe and describe" prompt.
- **`prompt` given** — the user wants reasoning about the audio (tone,
  background, music, etc.). Only the **understanding chain** is tried
  (`/chat/completions` with an `input_audio` content block).

Both chains are ordered, provider-agnostic candidate lists, tried in order
until one succeeds:

**Transcription chain:**
1. Explicit env override: `MULTIMEDIA_TRANSCRIBE_MODEL` +
   `MULTIMEDIA_AUDIO_API_KEY`/`MULTIMEDIA_AUDIO_BASE_URL` — if set, trusted
   and discovery is skipped entirely.
2. For each provider with a resolved credential (checked via
   `ctx.modelRegistry.getProviderAuthStatus`/`getApiKeyForProvider` — **not**
   whether a matching model appears in `getAvailable()`, since transcription
   models like `whisper-1` are never listed there), that provider's
   well-known transcription model id(s), in order:
   `openai` → `gpt-4o-mini-transcribe` → `whisper-1`;
   `openrouter` → `whisper-1`; `groq` → `whisper-large-v3`.
3. No credential for any known transcription-capable provider → chain
   exhausted (not failed) → falls back to the understanding chain.

**Understanding chain:**
1. Explicit env override: `MULTIMEDIA_AUDIO_MODEL` + key/base URL.
2. Registry hint-match: `ctx.modelRegistry.getAvailable()` searched for a
   known audio-input-capable chat model (`gpt-audio`, `gpt-audio-mini`,
   `gpt-4o-audio-preview`, ...) via `findModelByNameHint`.
3. No credential/model resolvable → chain exhausted.

A candidate is skipped (tried next) only when it was never resolvable (no
credential), or the provider rejects the model as unrecognized (a 400
"model does not exist"-shaped response). A genuine 401/429/network failure
from an already-resolved candidate is surfaced immediately as-is — never
silently retried past a real auth/rate-limit error. On full exhaustion, one
clear tool error is returned (never a raw 401), naming every candidate tried
and why.

Set `PI_MULTIMEDIA_DEBUG=1` for structured, one-line-per-candidate debug
logging to stderr (off by default):

```
[pi-multimedia] chain=transcription candidate=1/3 provider=openai model=gpt-4o-mini-transcribe result=skip reason=no-credential
[pi-multimedia] chain=transcription candidate=2/3 provider=openrouter model=whisper-1 result=success
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

`understand_audio`'s resolution is described above (candidate chains, issue
#243). `understand_video` keeps the older, simpler two-step resolution: a
registry name-hint match first, then env var fallback.

| Variable | Purpose |
| --- | --- |
| `MULTIMEDIA_AUDIO_API_KEY` | API key for `understand_audio`'s env-override candidates (both chains) |
| `MULTIMEDIA_AUDIO_BASE_URL` | Optional override of the audio API base URL |
| `MULTIMEDIA_AUDIO_MODEL` | Explicit understanding-chain model override |
| `MULTIMEDIA_TRANSCRIBE_MODEL` | Explicit transcription-chain model override |
| `MULTIMEDIA_VIDEO_API_KEY` | API key for `understand_video` |
| `MULTIMEDIA_VIDEO_BASE_URL` | Optional override of the video/vision API base URL |
| `MULTIMEDIA_VIDEO_MODEL` | Overrides the vision model/search hint (default `gpt-4o`) |
| `PI_MULTIMEDIA_DEBUG` | Set to `1` for structured per-candidate debug logging (see above) |

Without a key resolved via either path, `execute()` returns a normal
`isError` tool result (never throws) explaining the missing configuration.
`understand_video` additionally requires a local `ffmpeg`/`ffprobe` binary
on `PATH`.

See issue #235 for the design rationale behind preferring registry reuse
over a dedicated new Settings UI page, and issue #243 for the transcription
vs. understanding candidate-chain design.

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

