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

Both tools read their API key/base URL from process environment variables,
independent of pi-desktop's own per-model settings store
(`src/main/settings/store.ts`):

| Variable | Purpose |
| --- | --- |
| `MULTIMEDIA_AUDIO_API_KEY` | API key for `understand_audio` |
| `MULTIMEDIA_AUDIO_BASE_URL` | Optional override of the audio API base URL |
| `MULTIMEDIA_VIDEO_API_KEY` | API key for `understand_video` |
| `MULTIMEDIA_VIDEO_BASE_URL` | Optional override of the video/vision API base URL |

Without a key set, `execute()` returns a normal `isError` tool result (never
throws) explaining the missing configuration. `understand_video` additionally
requires a local `ffmpeg`/`ffprobe` binary on `PATH`.

**Known gap**: unlike pi-desktop's built-in model providers, there is
currently no Settings UI to configure these keys — they must be set as real
process environment variables before launching pi-desktop. Wiring this
extension into the existing settings store is tracked as a follow-up (not
part of this issue's scope).

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

