# Reusable audio player

`client/src/components/audio-player` exports `AudioPlayer` and its public types.
The module owns playback, waveform rendering, seeking, and timed-transcript UI.
It does not know about eval jobs, artifact APIs, storage, or account permissions.

## Use on another page

```tsx
import { AudioPlayer, type AudioTranscriptSegment } from "@/components/audio-player";

const transcript: AudioTranscriptSegment[] = [
  { start: 0.5, end: 2.8, text: "Hello!", speaker: "User", channel: 0 },
  { start: 3, end: 5.2, text: "How can I help?", speaker: "Agent", channel: 1 },
];

<AudioPlayer
  key={recordingId}
  src={recordingUrl}
  waveformSrc={optionalSameOriginPreviewUrl}
  title="Conversation recording"
  channels={[{ label: "User / left" }, { label: "Agent / right" }]}
  transcript={transcript}
  downloadUrl={recordingUrl}
/>
```

- `src` is the playable audio URL. Keep authorization in the page/API that
  supplies it. Optional `waveformSrc` supplies a separate, readable preview URL;
  otherwise waveform extraction fetches `src`. Direct cross-origin preview
  URLs need GET CORS permission; native playback can work without it.
- The recording determines the number of waveform lanes, not `channels`.
  `channels` supplies optional labels and CSS colors; unlabeled lanes use
  numbered labels. Mono, stereo, and multichannel files (up to 32 channels) share
  the same module. Integer PCM at 8/16/24/32 bits, float PCM at 32/64 bits, and
  WAVE_FORMAT_EXTENSIBLE PCM are supported. Compressed WebM/Opus and other
  recognized audio containers use WebCodecs when the browser supports their
  codec, preserving every decoded channel instead of downmixing to stereo.
- Transcript `start` and `end` are seconds relative to this recording, not the
  whole job. `channel` is zero-based. Overlapping speech is supported.
- Transcript previews are bounded to the first 1,000 supplied segments and
  4,000 characters per segment. A visible notice explains truncation; the eval
  result's original transcript artifact remains available for download.
- Use `transcriptLoading`, `transcriptError`, and `transcriptNote` to describe
  the page's transcript-loading state. `showTranscript={false}` hides the panel.
- `onTimeChange` reports committed playback positions, at roughly 10 Hz while
  playing. Drag previews do not trigger it. Native media events can also update
  the position.
- A changed `src` resets playback and cancels old waveform work. Key by the
  recording's stable identity to also reset zoom, control preferences, and
  transcript-follow state when selecting a different recording.

## Interaction and performance

Playback uses the browser's native audio element. A frame-synchronized playhead
and clipped played-waveform overlay update without repainting the waveform
canvases. PCM sample reading, compressed audio decoding, and peak extraction run
in a worker; viewport-local canvases redraw for data, size, scroll, or theme
changes, coalesced to one frame.
Each canvas backing store is limited to 2,048 by 128 pixels, independently of
zoom and DPR; even 32 channels' two surfaces total at most 64 MiB of pixel data.
Zoom supports 1x, 2x, 4x, and 8x with horizontal scrolling.

Dragging pauses audio and previews a position. Releasing commits one seek and
resumes only if playback was running before the drag. Touch supports horizontal
scrubbing while preserving vertical page scrolling. The timeline is keyboard
accessible: arrows seek 5 seconds, Page Up/Down seek 10 seconds, Home/End jump to
the beginning/end, and Space toggles playback. Clicking a transcript seeks to
its start. Scrolling the transcript turns off automatic following.

Waveform downloads are capped at 64 MiB, including responses without a
Content-Length header. The bounded encoded buffer transfers to the worker,
which reads PCM samples directly into at most 4,096 peaks per channel. Compressed
audio is demuxed with Mediabunny and decoded with native WebCodecs in batches of
eight packets. Each decoded frame contributes peaks immediately and is closed;
one small sample plane is reused across channels. It does not allocate full
decoded channel arrays or invoke `decodeAudioData`. Packet size (1 MiB), frame
size (65,536 samples per channel), sample rate (8-192 kHz), duration (6 hours),
total decoded samples (512 million), and processing time (30 seconds) are capped.
Cancelling or changing the source terminates the worker. This prevents a small
compressed file from expanding into unbounded waveform-processing memory/work.
Downloads accumulate into one capped buffer, using the Content-Length when
present or a resizable ArrayBuffer otherwise, instead of retaining all chunks
and then copying the whole recording. Older browsers without resizable buffers
need Content-Length for a waveform preview; native playback still works.
Encoded HTTP responses use the resizable-buffer path because fetch supplies
decoded bytes, not the compressed size reported by Content-Length.

Recognized compressed formats (WebM, Ogg, MP3, AAC, MP4/M4A, FLAC) can have waveform
previews when the browser's WebCodecs audio decoder supports the codec. WebM
duration is derived from packets even when MediaRecorder omits duration metadata.
Unsupported codecs/browsers, malformed files, exceeded processing limits, and
failed preview requests show distinct messages instead of fabricated waveforms.
The native audio element preloads metadata rather than downloading the whole
recording before playback. Waveform fetching starts only when the player enters
the viewport. This is not a streaming waveform implementation.

If neither native metadata nor decoded waveform duration is available, recordings
retain visible native audio controls and relative seeking. The custom timeline
becomes available once duration is known; it never guesses the recording's length.

Transcript previews use bounded counts/text, an indexed active-segment lookup,
and a memoized row list that reconciles only when the active segment changes,
not on every playback-clock update. For overlapping speech, the first active
segment is highlighted and followed; all supplied segments remain visible.

## Eval integration

`EvalRecordingPlayer` adapts job artifacts to the generic player. It loads only
the selected recording, selects a folder-matching `analysis/turns.json`, and
uses speaker-segment timestamps when available. The transcript download is
capped at 5 MiB. Job detail responses provide same-origin `previewUrl` links for
listed audio and turns.json artifacts. The player uses these links for waveform
and transcript reads, while playback and downloads keep their signed URLs.
An unambiguous raw-metric transcript is a fallback and is labeled
as turn-level timing. Ambiguous or other-chunk transcripts are not attached.
Metric fallbacks match the complete agent-sanitized case/chunk identity after
stripping its generated timestamp/nonce suffix; unknown folder formats and
colliding identities are rejected instead of guessing from a prefix.
Unscoped filenames never receive a metric-backed transcript. Historical
root-level turns.json artifacts are accepted only when the job has exactly one
audio recording; multiple flat-layout recordings need an explicit association.
Python non-finite JSON tokens are sanitized with a linear, quote-aware scan;
speech strings and escaped quotes are preserved without regex backtracking.
The player never generates speech recognition or sends recordings to a new
third-party service.

## Preview access and storage CORS

Eval previews use authenticated `GET /api/eval-jobs/:id/artifact-preview?name=...`.
The route applies the same live job-view permission as the detail page, excludes
Analyze jobs, and accepts only listed artifacts with an exact `jobs/:id/:name`
storage key. It reads from the job owner's user bucket or the system bucket.
User-defined endpoints receive the same per-connection DNS/SSRF safeguards as
Analyze; failures never fall back to a different bucket. No URL supplied by the
browser is fetched by Core. Streams are private/no-store, allow 45 seconds for
storage to open, reset a 30-second idle deadline on transfer progress, and retain
a five-minute total bound. They enforce actual-byte limits and allow at most four
streams per user / 32 per process, supporting two simultaneous result pages per
user. Both preview readers retry HTTP 429 up to three times with bounded
Retry-After/backoff delays; persistent throttling shows an explicit busy message.
Source changes cancel requests and pending retry timers. Disconnects abort
storage access and release resources. No server
audio decoder, FFmpeg runtime dependency, schema migration, bucket policy change,
or new environment configuration is needed.

These same-origin eval previews do not require browser CORS on the bucket.
For other pages using direct cross-origin `src`/`waveformSrc` URLs, the following
bucket configuration still applies:

Native audio playback does not require CORS, but direct waveform and transcript
reads do. An S3-compatible bucket CORS rule is:

```json
[
  {
    "AllowedOrigins": ["https://vox.agora.build"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Encoding"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace the origin with the deployed instance's origin. This is a bucket-owner
configuration step, not a public-read policy; object access still requires the
signed URL. Check the browser network panel for CORS errors on direct storage
reads. For eval previews, inspect the authenticated preview response instead
(401/403 access, 413 size, 429 concurrency, 502/504 storage). Vox does not change
bucket policies.

## Third-party dependency

The worker includes unmodified Mediabunny 1.61.1 (MPL-2.0) for local demuxing only;
it does not send audio to another service. Attribution, license, and the exact
source archive link are served at `/licenses/mediabunny.txt`.

## Tests

```sh
npm exec -- vitest run tests/audio-player-utils.test.ts tests/encoded-waveform.test.ts tests/artifact-preview.test.ts tests/artifact-storage.test.ts tests/preview-fetch.test.ts
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5178 npm exec -- playwright test tests/e2e/audio-player.spec.ts
```

The browser tests use local generated WAVs, committed synthetic audio fixtures,
and mocked APIs; point them at a local Vox build/preview. Fixtures can be
regenerated with `node tests/fixtures/audio/generate.mjs` when FFmpeg is available;
running the tests does not require it. They cover genuine canvas waveforms,
independent WebM stereo channels, MP3/MP4/M4A/AAC/Ogg/FLAC, six-channel Opus,
an 82-second durationless WebM,
same-origin previews, transient/persistent throttling, unavailable WebCodecs,
malformed media, decoder deadlines,
and cancellation, as well as playback, drag/keyboard/transcript seeking,
source switching, graceful failures,
PCM-derived duration fallback, and mobile touch scrubbing.
Additional regressions cover PCM encodings and malformed files, safe unsupported
format handling, transcript limits, stalled-playback pause, and speed preservation
when the native media source reloads without remounting.
Canvas bounds are tested with 32 channels, 8x zoom, and DPR 2. Browser tests also
cover deferred waveform requests and unknown-duration native-control fallback.
