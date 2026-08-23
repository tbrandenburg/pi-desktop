import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // video.test.ts shells out to real `ffmpeg`/`ffprobe` subprocesses to
    // generate fixtures and extract frames; under system load this can
    // occasionally exceed vitest's default 5000ms per-test timeout even
    // though nothing is hanging (observed empirically, not a guessed
    // constant).
    testTimeout: 20000,
  },
});
