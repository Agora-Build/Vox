import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

function recordingWav(channels = 2, duration = 12) {
  const sampleRate = 16000;
  const frames = sampleRate * duration;
  const bytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    for (let channel = 0; channel < channels; channel++) {
      const envelope = (time + channel * 1.1) % 3 < 1.5 ? 0.65 : 0;
      buffer.writeInt16LE(Math.round(Math.sin(time * Math.PI * 2 * (220 + channel * 100)) * envelope * 32767), 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

async function mockRecording(page: Page, options: { encoded?: "stereo" | "stereo-live" | "six-channel" | "long-stereo" | "mp3" | "mp4" | "m4a" | "aac" | "ogg" | "flac"; preview?: boolean; previewBusy?: number; channels?: number; blockWaveform?: boolean; unsupportedWaveform?: boolean; malformedWaveform?: boolean; largeTranscript?: boolean; overlappingTranscript?: boolean; flat?: boolean; multiple?: boolean; transcriptError?: boolean; scroll?: boolean } = {}) {
  const webm = options.encoded && ["stereo", "stereo-live", "six-channel", "long-stereo"].includes(options.encoded);
  const extension = options.encoded ? webm ? "webm" : options.encoded : "wav";
  const filename = options.encoded ? webm ? `${options.encoded}.webm` : `stereo.${extension}` : "";
  const recording = options.encoded ? readFileSync(new URL(`../fixtures/audio/${filename}`, import.meta.url)) : recordingWav(options.channels ?? 2);
  const contentType = ({ mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4" } as Record<string, string>)[extension] ?? `audio/${extension}`;
  const alternate = recordingWav(1, 8);
  const prefix = options.flat ? "" : "vox-RSP-chunk_001-abc/";
  const previewUrl = (name: string) => options.preview ? `/api/eval-jobs/101/artifact-preview?name=${encodeURIComponent(name)}` : undefined;
  const artifacts = [
    { name: `${prefix}recording.${extension}`, url: `/fixture-audio/recording.${extension}`, previewUrl: previewUrl(`recording.${extension}`), size: recording.length, contentType },
    { name: `${prefix}analysis/turns.json`, url: "/fixture-audio/turns.json", previewUrl: previewUrl("turns.json"), size: 500, contentType: "application/json" },
    ...(options.multiple ? [
      { name: options.flat ? "alternate.wav" : "vox-INT-chunk_002-def/recording.wav", url: "/fixture-audio/alternate.wav", size: alternate.length, contentType: "audio/wav" },
      ...(!options.flat ? [{ name: "vox-INT-chunk_002-def/analysis/turns.json", url: "/fixture-audio/alternate-turns.json", size: 100, contentType: "application/json" }] : []),
    ] : []),
  ];
  const previewAttempts = new Map<string, number>();
  const serveArtifact = async (route: Route, preview = false) => {
    const url = new URL(route.request().url());
    const path = preview ? url.searchParams.get("name")! : url.pathname;
    if (preview && options.previewBusy) {
      const attempts = (previewAttempts.get(path) ?? 0) + 1;
      previewAttempts.set(path, attempts);
      if (attempts <= options.previewBusy) { await route.fulfill({ status: 429, headers: { "Retry-After": "0" }, body: "Busy" }); return; }
    }
    if (/\.(wav|webm|mp3|mp4|m4a|aac|ogg|flac)$/.test(path)) {
      if (options.blockWaveform && !preview && route.request().resourceType() === "fetch") { await route.abort("failed"); return; }
      if (options.unsupportedWaveform && route.request().resourceType() === "fetch") { await route.fulfill({ body: Buffer.from("not an audio fixture") }); return; }
      if (options.malformedWaveform && route.request().resourceType() === "fetch") { await route.fulfill({ body: Buffer.from("OggS malformed compressed fixture") }); return; }
      const body = path.includes("alternate") ? alternate : recording;
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      await route.fulfill({ status: range ? 206 : 200, contentType: path.includes("alternate") ? "audio/wav" : contentType, headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}) }, body: body.subarray(start, end + 1) });
    } else if (options.transcriptError && !preview) await route.fulfill({ status: 403, body: "Forbidden" });
    else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.largeTranscript ? [
      { user_segments: Array.from({ length: 1500 }, (_, index) => ({ start: index * 0.01, end: index * 0.01 + 0.1, text: `Segment ${index}` })) },
    ] : options.overlappingTranscript ? [
      { user_segments: [{ start: 0, end: 4, text: "User speaking" }], agent_segments: [{ start: 1, end: 8, text: "Agent speaking" }] },
    ] : path.includes("alternate") ? [
      { agent_segments: [{ start: 1, end: 5, text: "Another recording, another transcript." }] },
    ] : [
      { user_segments: [{ start: 0, end: 4, text: "Can you help me build something?" }], agent_segments: [{ start: 4, end: 8, text: "Absolutely. What do you have in mind?" }] },
      { user_segments: [{ start: 9, end: 11, text: "A player with every channel visible." }] },
    ]) });
  };
  await page.route("**/fixture-audio/**", (route) => serveArtifact(route));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/artifact-preview")) { await serveArtifact(route, true); return; }
    const user = { id: 1, username: "Builder", email: "builder@example.test", plan: "principal", isAdmin: false, isEnabled: true, organizationId: null, orgRole: null };
    const responses: Record<string, unknown> = {
      "/api/auth/status": { initialized: true, user }, "/api/config": { organizationsEnabled: "false" }, "/api/plugins": [],
      "/api/eval-jobs/101/detail": {
        job: { id: 101, evalFlowId: null, evalSetId: null, status: "completed", createdBy: 1, createdAt: "2026-10-04T00:00:00Z", startedAt: null, completedAt: null, snapshot: null },
        result: { id: 101, evalJobId: 101, artifactStatus: "uploaded", artifactFiles: artifacts, rawData: {} }, evalFlowName: "Waveform test", creatorName: "Builder",
      },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responses[path] ?? {}) });
  });
  await page.goto("/console/eval-jobs/101", { waitUntil: "domcontentloaded" });
  const player = page.getByTestId("audio-player");
  if (options.scroll !== false) await player.scrollIntoViewIfNeeded();
  return player;
}

test("recordings show genuine per-channel waveforms and a timed transcript", async ({ page }) => {
  const player = await mockRecording(page);
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await expect(player.getByText("Channel 01", { exact: true })).toBeVisible();
  await expect(player.getByText("Channel 02", { exact: true })).toBeVisible();
  await expect(player.getByRole("slider", { name: "Recording timeline" })).toHaveAttribute("aria-valuemax", "12");
  await expect(player.getByText("Can you help me build something?", { exact: true })).toBeVisible();
  expect(await player.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
});

for (const encoded of ["stereo", "stereo-live"] as const) {
  test(`${encoded} WebM decodes real, independent stereo waveforms`, async ({ page }) => {
    // No whole-file PCM decode is allowed, including when metadata has no duration.
    await page.addInitScript(() => {
      AudioContext.prototype.decodeAudioData = async () => { throw new Error("Unbounded decoder invoked"); };
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => Infinity, configurable: true });
    });
    const player = await mockRecording(page, { encoded });
    await expect(player.getByTestId("player-channel")).toHaveCount(2);
    const timeline = player.getByRole("slider", { name: "Recording timeline" });
    await expect.poll(async () => Number(await timeline.getAttribute("aria-valuemax"))).toBeCloseTo(12, 1);
    const readHalves = () => player.locator("canvas").evaluateAll((canvases: HTMLCanvasElement[]) => canvases.filter((_, index) => index % 2 === 0).map((canvas) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = [0, 0];
      for (let x = 0; x < canvas.width; x++) for (let y = 0; y < canvas.height; y++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) counts[x < canvas.width / 2 ? 0 : 1]++;
      }
      return counts;
    }));
    // Lanes mount before the effect paints their canvases; assert the actual paint.
    await expect.poll(async () => (await readHalves()).map((halves, channel) => halves[channel] > halves[1 - channel] * 4)).toEqual([true, true]);
    await player.getByRole("button", { name: "Play recording", exact: true }).click();
    await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
    await timeline.focus(); await timeline.press("ArrowRight");
    expect(Number(await timeline.getAttribute("aria-valuenow"))).toBeGreaterThan(5);
  });
}

test("six-channel Opus preserves every separate channel, without stereo downmixing", async ({ page }) => {
  const player = await mockRecording(page, { encoded: "six-channel" });
  await expect(player.getByTestId("player-channel")).toHaveCount(6);
  await expect(player.getByText("Channel 06", { exact: true })).toBeVisible();
  const readCounts = () => player.locator("canvas").evaluateAll((canvases: HTMLCanvasElement[]) => canvases.filter((_, index) => index % 2 === 0).map((canvas) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.reduce((sum, value, index) => sum + Number(index % 4 === 3 && value > 0), 0);
  }));
  await expect.poll(async () => { const counts = await readCounts(); return counts.length === 6 && counts[5] > counts[0] * 3 && counts.every((count) => count > 0); }).toBe(true);
});

for (const encoded of ["mp3", "mp4", "m4a", "aac", "ogg", "flac"] as const) {
  test(`${encoded} audio artifacts support waveforms and playback`, async ({ page }) => {
    const player = await mockRecording(page, { encoded, preview: true });
    await expect(player.getByTestId("player-channel")).toHaveCount(2);
    await expect.poll(async () => Number(await player.getByRole("slider", { name: "Recording timeline" }).getAttribute("aria-valuemax"))).toBeCloseTo(3, 0);
    await player.getByRole("button", { name: "Play recording", exact: true }).click();
    await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
  });
}

test("an 82-second WebM gets a complete waveform and duration before playback", async ({ page }) => {
  const player = await mockRecording(page, { encoded: "long-stereo" });
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await expect.poll(async () => Number(await player.getByRole("slider", { name: "Recording timeline" }).getAttribute("aria-valuemax"))).toBeCloseTo(82, 1);
  expect(await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
});

test("same-origin preview URLs bypass blocked storage reads while playback keeps its signed URL", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "fetch") reads.push(request.url()); });
  const player = await mockRecording(page, { encoded: "stereo-live", preview: true, blockWaveform: true, transcriptError: true });
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await expect(player.getByText("Can you help me build something?", { exact: true })).toBeVisible();
  expect(reads.some((url) => url.includes("/fixture-audio/"))).toBe(false);
  expect(reads.filter((url) => url.includes("/artifact-preview")).length).toBe(2);
  await expect(player.getByTestId("player-audio")).toHaveAttribute("src", "/fixture-audio/recording.webm");
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("busy previews retry automatically and recover both waveform and transcript", async ({ page }) => {
  const player = await mockRecording(page, { encoded: "stereo-live", preview: true, previewBusy: 1 });
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await expect(player.getByText("Can you help me build something?", { exact: true })).toBeVisible();
  await expect(player.getByText("Waveform unavailable.", { exact: false })).toHaveCount(0);
});

test("persistent preview throttling is explained without misleading storage/CORS errors", async ({ page }) => {
  const player = await mockRecording(page, { encoded: "stereo", preview: true, previewBusy: Infinity });
  await expect(player.getByText("Waveform previews are busy.", { exact: false })).toBeVisible();
  await expect(player.getByText("Transcript previews are busy.", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("browsers without a WebCodecs audio decoder get a clear fallback and working playback", async ({ page }) => {
  await page.route("**/*waveform.worker*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `globalThis.AudioDecoder = undefined;\n${await response.text()}` });
  });
  const player = await mockRecording(page, { encoded: "stereo" });
  await expect(player.getByText("This browser cannot decode this recording's waveform.", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("malformed compressed files fail safely without blocking native playback", async ({ page }) => {
  const player = await mockRecording(page, { encoded: "stereo", malformedWaveform: true });
  await expect(player.getByText("waveform could not be decoded", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("a stalled decoder is terminated after the processing deadline", async ({ page }) => {
  await page.clock.install();
  await page.route("**/*waveform.worker*", (route) => route.fulfill({ contentType: "text/javascript", body: "self.onmessage = () => {};" }));
  const workerStarted = page.waitForRequest((request) => request.url().includes("waveform.worker"));
  const player = await mockRecording(page, { encoded: "stereo" });
  await workerStarted;
  await page.clock.fastForward(30_001);
  await expect(player.getByText("exceeds the safe waveform processing limit", { exact: false })).toBeVisible();
  await expect(player.getByRole("button", { name: "Play recording", exact: true })).toBeEnabled();
});

test("changing recordings cancels stalled WebM work without replacing the new waveform", async ({ page }) => {
  let requests = 0;
  await page.route("**/*waveform.worker*", async (route) => {
    if (++requests === 1) await route.fulfill({ contentType: "text/javascript", body: "self.onmessage = () => {};" });
    else await route.continue();
  });
  const workerStarted = page.waitForRequest((request) => request.url().includes("waveform.worker"));
  const player = await mockRecording(page, { encoded: "stereo-live", multiple: true });
  await workerStarted;
  await page.getByRole("combobox", { name: "Choose recording" }).click();
  await page.getByRole("option", { name: "vox-INT-chunk_002-def/recording.wav", exact: true }).click();
  await expect(player.getByTestId("player-channel")).toHaveCount(1);
  await expect(player.getByRole("slider", { name: "Recording timeline" })).toHaveAttribute("aria-valuemax", "8");
  await expect(player.getByText("Another recording, another transcript.", { exact: true })).toBeVisible();
});

for (const variant of ["known length", "unknown length", "decoded compressed", "legacy browser"] as const) {
  test(`split WAV headers work with ${variant} downloads`, async ({ page }) => {
    await page.addInitScript(({ unknownLength, encoded, legacy }) => {
      if (legacy) Object.defineProperty(ArrayBuffer.prototype, "resize", { value: undefined, configurable: true });
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!response.url.includes("/fixture-audio/") || !response.url.endsWith(".wav")) return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const headers = new Headers(response.headers);
        if (unknownLength) headers.delete("Content-Length");
        else headers.set("Content-Length", String(bytes.byteLength));
        if (encoded) { headers.set("Content-Encoding", "gzip"); headers.set("Content-Length", "16"); }
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) { controller.close(); return; }
            const end = Math.min(bytes.length, offset < 12 ? offset + 5 : offset + 4096);
            controller.enqueue(bytes.slice(offset, end)); offset = end;
          },
        });
        return new Response(body, { status: response.status, headers });
      };
    }, { unknownLength: variant === "unknown length" || variant === "legacy browser", encoded: variant === "decoded compressed", legacy: variant === "legacy browser" });
    const player = await mockRecording(page);
    if (variant === "legacy browser") {
      await expect(player.getByText("Waveform previews require a Content-Length", { exact: false })).toBeVisible();
      await player.getByRole("button", { name: "Play recording", exact: true }).click();
      await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
    } else {
      await expect(player.getByTestId("player-channel")).toHaveCount(2);
      await expect(player.getByRole("slider", { name: "Recording timeline" })).toHaveAttribute("aria-valuemax", "12");
    }
  });
}

test("overlapping speech has one indexed highlight consistent with transcript following", async ({ page }) => {
  const player = await mockRecording(page, { overlappingTranscript: true });
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await expect(player.getByText("Agent speaking", { exact: true })).toBeVisible();
  const media = player.getByTestId("player-audio");
  await media.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 2; });
  await expect(player.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(player.locator('[aria-current="true"]')).toContainText("User speaking");
  await media.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 5; });
  await expect(player.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(player.locator('[aria-current="true"]')).toContainText("Agent speaking");
});

for (const multiple of [false, true]) {
  test(`flat-layout root transcripts ${multiple ? "are omitted for multiple recordings" : "work for one recording"}`, async ({ page }) => {
    const player = await mockRecording(page, { flat: true, multiple });
    await expect(player.getByTestId("player-channel")).toHaveCount(2);
    if (!multiple) await expect(player.getByText("Can you help me build something?", { exact: true })).toBeVisible();
    else {
      await expect(player.getByText("No timed transcript is available", { exact: false })).toBeVisible();
      await page.getByRole("combobox", { name: "Choose recording" }).click();
      await page.getByRole("option", { name: "alternate.wav", exact: true }).click();
      await expect(player.getByTestId("player-channel")).toHaveCount(1);
      await expect(player.getByText("No timed transcript is available", { exact: false })).toBeVisible();
      await expect(player.getByText("Can you help me build something?", { exact: true })).toHaveCount(0);
    }
  });
}

test("the player is not hard-coded to stereo", async ({ page }) => {
  const player = await mockRecording(page, { channels: 6 });
  await expect(player.getByTestId("player-channel")).toHaveCount(6);
  await expect(player.getByText("Channel 06", { exact: true })).toBeVisible();
  await expect(player.getByText("6 channels", { exact: false })).toBeVisible();
});

test("playback advances smoothly, and waveform dragging commits one seek then resumes", async ({ page }) => {
  const player = await mockRecording(page);
  const media = player.getByTestId("player-audio");
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
  const timeline = player.getByRole("slider", { name: "Recording timeline" });
  await timeline.scrollIntoViewIfNeeded();
  const box = (await timeline.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + 55); await page.mouse.down();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  const original = await media.evaluate((audio: HTMLAudioElement) => audio.currentTime);
  await page.mouse.move(box.x + box.width * 0.75, box.y + 55, { steps: 10 });
  expect(await media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(original, 1);
  await page.mouse.up();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(8.9);
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await player.getByRole("button", { name: "Pause recording", exact: true }).click();
  await expect(player.locator('[aria-current="true"]')).toContainText("A player with every channel visible.");
});

test("keyboard and transcript seeking, zoom, speed and volume controls work", async ({ page }) => {
  const player = await mockRecording(page);
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  const timeline = player.getByRole("slider", { name: "Recording timeline" });
  await timeline.focus(); await timeline.press("ArrowRight");
  await expect(timeline).toHaveAttribute("aria-valuenow", "5");
  await player.getByRole("button").filter({ hasText: "A player with every channel visible." }).click();
  await expect(timeline).toHaveAttribute("aria-valuenow", "9");
  await timeline.focus(); await timeline.press("Home"); await expect(timeline).toHaveAttribute("aria-valuenow", "0");
  await player.getByLabel("Playback speed").selectOption("1.5");
  expect(await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);
  await player.getByRole("button", { name: "Mute recording" }).click();
  expect(await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.volume)).toBe(0);
  await player.getByRole("button", { name: "Zoom in waveform" }).click();
  expect(await timeline.evaluate((element) => element.clientWidth)).toBeGreaterThan(await player.evaluate((element) => element.clientWidth));
});

test("source switching resets playback and uses only the matching transcript", async ({ page }) => {
  const player = await mockRecording(page, { multiple: true });
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await player.getByRole("button").filter({ hasText: "A player with every channel visible." }).click();
  await page.getByRole("combobox", { name: "Choose recording" }).click();
  await page.getByRole("option", { name: "vox-INT-chunk_002-def/recording.wav", exact: true }).click();
  await expect(player.getByTestId("player-channel")).toHaveCount(1);
  await expect(player.getByRole("slider", { name: "Recording timeline" })).toHaveAttribute("aria-valuenow", "0");
  await expect(player.getByText("Another recording, another transcript.", { exact: true })).toBeVisible();
  await expect(player.getByText("Can you help me build something?", { exact: true })).toHaveCount(0);
});

test("waveform and transcript failures never block native audio playback", async ({ page }) => {
  const player = await mockRecording(page, { blockWaveform: true, transcriptError: true });
  await expect(player.getByText("Waveform unavailable.", { exact: false })).toBeVisible();
  await expect(player.getByText("Transcript could not be loaded.", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("PCM duration supports seekable recordings whose native duration is infinite", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => Infinity, configurable: true }));
  const player = await mockRecording(page);
  const timeline = player.getByRole("slider", { name: "Recording timeline" });
  await expect(timeline).toHaveAttribute("aria-valuemax", "12");
  await timeline.focus(); await timeline.press("ArrowRight");
  await expect(timeline).toHaveAttribute("aria-valuenow", "5");
});

test("unsupported waveform encodings do not invoke an unbounded audio decoder", async ({ page }) => {
  await page.addInitScript(() => {
    AudioContext.prototype.decodeAudioData = async () => { throw new Error("Unbounded decoder invoked"); };
  });
  const player = await mockRecording(page, { unsupportedWaveform: true });
  await expect(player.getByText("format or channel layout is not supported", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("recordings with unknown duration retain custom playback and skip controls", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => Infinity, configurable: true }));
  const player = await mockRecording(page, { unsupportedWaveform: true });
  const media = player.getByTestId("player-audio");
  await expect(media).not.toHaveAttribute("controls");
  await expect(media).toBeHidden();
  await expect(player.getByText("Duration is unavailable.", { exact: false })).toBeVisible();
  await expect(player.getByRole("slider", { name: "Recording timeline" })).toHaveAttribute("aria-disabled", "true");
  await expect(player.getByRole("button", { name: "Forward 10 seconds" })).toBeEnabled();
  await player.getByRole("button", { name: "Forward 10 seconds" }).click();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(9.9);
  await player.getByRole("button", { name: "Back 10 seconds" }).click();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
  await player.getByRole("button", { name: "Pause recording", exact: true }).click();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
});

test("slow WebM waveform loading never flashes native controls", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => Infinity, configurable: true });
    const state = { observed: false, nativeShown: false };
    Object.assign(window, { audioVisibility: state });
    new MutationObserver(() => {
      for (const audio of document.querySelectorAll<HTMLAudioElement>('audio[data-testid="player-audio"]')) {
        state.observed = true;
        if (audio.controls || getComputedStyle(audio).display !== "none") state.nativeShown = true;
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["controls", "hidden", "style"] });
  });
  await page.route("**/*waveform.worker*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const player = await mockRecording(page, { encoded: "stereo-live" });
  const media = player.getByTestId("player-audio");
  await expect(player.getByText("Building channel waveforms...", { exact: true })).toBeVisible();
  await expect(player.getByRole("button", { name: "Play recording", exact: true })).toBeVisible();
  await expect(media).toBeHidden();
  await expect(media).not.toHaveAttribute("controls");
  const timeline = player.getByRole("slider", { name: "Recording timeline" });
  await expect.poll(async () => Number(await timeline.getAttribute("aria-valuemax"))).toBeCloseTo(12, 1);
  await expect(timeline).toHaveAttribute("aria-disabled", "false");
  await expect(player.getByText("Duration is unavailable.", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { audioVisibility: { observed: boolean; nativeShown: boolean } }).audioVisibility)).toEqual({ observed: true, nativeShown: false });
  await timeline.focus(); await timeline.press("ArrowRight");
  await expect(timeline).toHaveAttribute("aria-valuenow", "5");
});

test("waveform downloads wait until the player is visible", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 300 });
  let waveformRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/fixture-audio/recording.wav") && request.resourceType() === "fetch") waveformRequests++; });
  const player = await mockRecording(page, { scroll: false });
  await expect(player).toBeAttached();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(waveformRequests).toBe(0);
  await player.scrollIntoViewIfNeeded();
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  expect(waveformRequests).toBe(1);
});

test.describe("maximum-channel canvas bounds", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  test("32 channels at 8x zoom keep bounded viewport-local canvases", async ({ page }) => {
    const player = await mockRecording(page, { channels: 32 });
    await expect(player.getByTestId("player-channel")).toHaveCount(32);
    for (let zoom = 0; zoom < 3; zoom++) await player.getByRole("button", { name: "Zoom in waveform" }).click();
    const viewport = player.locator(".audio-wave-scroll");
    await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth / 2; });
    await expect.poll(() => player.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => parseFloat(canvas.style.left))).toBeGreaterThan(0);
    const dimensions = await player.locator("canvas").evaluateAll((canvases: HTMLCanvasElement[]) => canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })));
    expect(dimensions).toHaveLength(64);
    expect(dimensions.every(({ width, height }) => width > 0 && width <= 2048 && height > 0 && height <= 128)).toBe(true);
    expect(dimensions.reduce((bytes, { width, height }) => bytes + width * height * 4, 0)).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(await player.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0))).toBe(true);
  });
});

test("pausing while waiting clears the loading spinner", async ({ page }) => {
  const player = await mockRecording(page);
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  // Let native startup events finish before simulating a subsequent network stall.
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
  await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.dispatchEvent(new Event("waiting")));
  await expect(player.getByRole("button", { name: "Pause recording", exact: true }).locator(".animate-spin")).toHaveCount(1);
  await player.getByRole("button", { name: "Pause recording", exact: true }).click();
  await expect(player.getByRole("button", { name: "Play recording", exact: true }).locator(".animate-spin")).toHaveCount(0);
});

test("playback speed stays correct when media reloads without remounting the player", async ({ page }) => {
  const player = await mockRecording(page);
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  await player.getByLabel("Playback speed").selectOption("1.5");
  await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => { audio.src = "/fixture-audio/alternate.wav"; audio.load(); });
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
  await expect(player.getByLabel("Playback speed")).toHaveValue("1.5");
  expect(await player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);
});

test("large transcripts have a bounded, clearly labeled preview", async ({ page }) => {
  const player = await mockRecording(page, { largeTranscript: true });
  await expect(player.getByText("Transcript preview is limited", { exact: false })).toBeVisible();
  await expect(player.locator("[data-segment-index]")).toHaveCount(1000);
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("mobile player stays within the page and supports pointer scrubbing", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const player = await mockRecording(page);
  await expect(player.getByTestId("player-channel")).toHaveCount(2);
  const timeline = player.getByRole("slider", { name: "Recording timeline" });
  await timeline.scrollIntoViewIfNeeded();
  const timelineBox = (await timeline.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: timelineBox.x + timelineBox.width * 0.2, y: timelineBox.y + 60, id: 7 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: timelineBox.x + timelineBox.width * 0.5, y: timelineBox.y + 60, id: 7 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(6, 1);
  const box = (await player.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await player.screenshot({ path: info.outputPath("audio-player-mobile.png") });
});
