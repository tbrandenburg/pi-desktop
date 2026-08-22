# @pi-desktop/pi-multimedia (PoC)

Proof-of-concept first-party pi extension registering an `understand_audio`
tool. pi-ai's `Message` schema (as of `@earendil-works/pi-ai@0.84.1`) has no
`AudioContent`/`VideoContent` block type, so this tool bypasses that schema
entirely: it reads a local audio file, base64-encodes it, and makes a raw HTTP
call to an audio-capable chat completions API (`gpt-audio-1.5` request shape)
directly from `execute()`, returning the answer as a plain `TextContent` tool
result block — which fits the existing `AgentToolResult<TDetails>` contract
unchanged.

## Tool: `understand_audio`

| Param | Required | Description |
| --- | --- | --- |
| `path` | yes | Path to a local `.wav`/`.mp3`/`.m4a` file |
| `prompt` | no | What to ask about the audio (default: transcribe + describe) |

The actual network call is behind an injectable `fetchFn` so `src/audio.ts`
is fully unit-testable without ever hitting the network (see `src/audio.test.ts`).

## Known limitations (PoC scope)

- No real API key is configured in this sandbox; `execute()` will return an
  `isError` result if invoked for real without `MULTIMEDIA_AUDIO_API_KEY` set.
- `.m4a` files are labeled `mp3` for the API's `format` field without an
  actual transcode; a production version would transcode m4a -> wav/mp3 first.
- Large base64 audio payloads remain in the tool-result/conversation history
  across turns, which can bloat context; a production version should
  summarize/prune the raw base64 field from history after the model has seen it once.

## Video (research note, no code)

There is no native `video` content type in pi-ai's `Message` schema, so a
future `understand_video` tool has two options: (a) call a video-native model
directly (e.g. Gemini `generateContent` with a video part, using the Files API
for uploads beyond ~20MB inline) and return a text description, exactly like
this audio tool's raw-HTTP-call pattern; or (b) extract N frames locally with
`ffmpeg` and return them as `ImageContent` blocks (a type the existing
`AgentToolResult.content` already supports) alongside a text prompt, avoiding
any raw network dependency on one specific video-native model.
