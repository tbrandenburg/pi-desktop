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
| `prompt` | no | What to ask about the audio (default: transcribe + describe) |

The actual network call is behind an injectable `fetchFn` so `src/audio.ts`
is fully unit-testable without ever hitting the network (see `src/audio.test.ts`).

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

Both tools resolve their API key/base URL/model in two steps, in order:

1. **Registry match (preferred)**: if the tool is invoked from a real pi
   session, `ctx.modelRegistry.getAvailable()` — the same resolved
   credential set (settings.json + auth.json + OAuth) that already powers
   the model picker — is searched for a model whose id/name matches the
   configured hint (see `MULTIMEDIA_*_MODEL` below; defaults to
   `gpt-audio-1.5`/`gpt-transcribe`/`gpt-4o`), best-effort, exact-match
   first then substring. The search is restricted to models whose `api` is
   `"openai-completions"` — the one pi-ai API id whose wire format matches
   what this package's request builders send; other api ids
   (`openai-responses`, `anthropic-messages`, `bedrock-converse-stream`,
   etc.) are different, incompatible wire formats despite some sharing
   "openai" in the name. On a match, the model's own real, already-resolved
   API key/base URL (`ctx.modelRegistry.getApiKeyAndHeaders(model)`) is used
   — **no separate configuration needed** if a matching model is already
   set up in pi-desktop's Settings.
2. **Env var fallback**: if no registry is available (e.g. running this
   package standalone/outside pi-desktop, or in these unit tests) or no
   matching model is found, falls back to process environment variables:

| Variable | Purpose |
| --- | --- |
| `MULTIMEDIA_AUDIO_API_KEY` | API key for `understand_audio` |
| `MULTIMEDIA_AUDIO_BASE_URL` | Optional override of the audio API base URL |
| `MULTIMEDIA_AUDIO_MODEL` | Overrides the `understand` mode model/search hint (default `gpt-audio-1.5`) |
| `MULTIMEDIA_TRANSCRIBE_MODEL` | Overrides the `transcribe` mode model/search hint (default `gpt-transcribe`) |
| `MULTIMEDIA_VIDEO_API_KEY` | API key for `understand_video` |
| `MULTIMEDIA_VIDEO_BASE_URL` | Optional override of the video/vision API base URL |
| `MULTIMEDIA_VIDEO_MODEL` | Overrides the vision model/search hint (default `gpt-4o`) |

Without a key resolved via either path, `execute()` returns a normal
`isError` tool result (never throws) explaining the missing configuration.
`understand_video` additionally requires a local `ffmpeg`/`ffprobe` binary
on `PATH`.

See issue #235 for the design rationale behind preferring registry reuse
over a dedicated new Settings UI page.

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

