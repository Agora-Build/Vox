import { test, expect, type Page } from "@playwright/test";

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

async function mockRecording(page: Page, options: { channels?: number; blockWaveform?: boolean; unsupportedWaveform?: boolean; largeTranscript?: boolean; overlappingTranscript?: boolean; multiple?: boolean; transcriptError?: boolean; scroll?: boolean } = {}) {
  const wav = recordingWav(options.channels ?? 2);
  const alternate = recordingWav(1, 8);
  const prefix = "vox-RSP-chunk_001-abc";
  const artifacts = [
    { name: `${prefix}/recording.wav`, url: "/fixture-audio/recording.wav", size: wav.length, contentType: "audio/wav" },
    { name: `${prefix}/analysis/turns.json`, url: "/fixture-audio/turns.json", size: 500, contentType: "application/json" },
    ...(options.multiple ? [
      { name: "vox-INT-chunk_002-def/recording.wav", url: "/fixture-audio/alternate.wav", size: alternate.length, contentType: "audio/wav" },
      { name: "vox-INT-chunk_002-def/analysis/turns.json", url: "/fixture-audio/alternate-turns.json", size: 100, contentType: "application/json" },
    ] : []),
  ];
  await page.route("**/fixture-audio/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".wav")) {
      if (options.blockWaveform && route.request().resourceType() === "fetch") { await route.abort("failed"); return; }
      if (options.unsupportedWaveform && route.request().resourceType() === "fetch") { await route.fulfill({ body: Buffer.from("OggS compressed fixture") }); return; }
      const body = path.includes("alternate") ? alternate : wav;
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      await route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}) }, body: body.subarray(start, end + 1) });
    } else if (options.transcriptError) await route.fulfill({ status: 403, body: "Forbidden" });
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
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
  await expect(player.getByText("Waveform previews support PCM WAV recordings", { exact: false })).toBeVisible();
  await player.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect.poll(() => player.getByTestId("player-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
});

test("non-WAV recordings with unknown duration retain native seeking controls", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, "duration", { get: () => Infinity, configurable: true }));
  const player = await mockRecording(page, { unsupportedWaveform: true });
  const media = player.getByTestId("player-audio");
  await expect(media).toHaveAttribute("controls", "");
  await expect(media).toBeVisible();
  await expect(player.getByText("Native audio controls remain available for seeking.", { exact: false })).toBeVisible();
  await expect(player.getByRole("button", { name: "Forward 10 seconds" })).toBeEnabled();
  await player.getByRole("button", { name: "Forward 10 seconds" }).click();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(9.9);
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
