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
  title="Conversation recording"
  channels={[{ label: "User / left" }, { label: "Agent / right" }]}
  transcript={transcript}
  downloadUrl={recordingUrl}
/>
```

- `src` is the playable audio URL. Keep authorization in the page/API that
  supplies it. Cross-origin storage needs GET CORS permission for waveform
  extraction; native audio playback can still work without the waveform.
- The PCM WAV file determines the number of waveform lanes, not `channels`.
  `channels` supplies optional labels and CSS colors; unlabeled lanes use
  numbered labels. Mono, stereo, and multichannel files (up to 32 channels) share
  the same module. Integer PCM at 8/16/24/32 bits, float PCM at 32/64 bits, and
  WAVE_FORMAT_EXTENSIBLE PCM are supported.
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
canvases. PCM sample reading and peak extraction run in a worker; viewport-local
canvases redraw for data, size, scroll, or theme changes, coalesced to one frame.
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
which reads PCM samples directly into at most 4,096 peaks per channel. It does
not allocate full decoded channel arrays or invoke `decodeAudioData`, so a long
compressed file cannot expand into unbounded waveform-processing memory.

Compressed formats (MP3, WebM, Ogg, AAC, M4A, FLAC) remain playable using native
audio, but their waveform previews are unavailable. Non-WAV waveform fetches
stop after the header is recognized. Large WAVs, unsupported WAV encodings, and
failed CORS requests also show a clear message instead of a fabricated waveform.
The native audio element preloads metadata rather than downloading the whole
recording before playback. Waveform fetching starts only when the player enters
the viewport. This is not a streaming waveform implementation.

Non-WAV recordings without finite duration metadata retain visible native audio
controls and relative seeking. The custom full-duration waveform slider remains
unavailable until duration is known; it never guesses the recording's length.

Transcript previews use bounded counts/text, an indexed active-segment lookup,
and memoized rows so playback does not rerender every speech row.

## Eval integration

`EvalRecordingPlayer` adapts job artifacts to the generic player. It loads only
the selected recording, selects a folder-matching `analysis/turns.json`, and
uses speaker-segment timestamps when available. The transcript download is
capped at 5 MiB. An unambiguous raw-metric transcript is a fallback and is labeled
as turn-level timing. Ambiguous or other-chunk transcripts are not attached.
The player never generates speech recognition or sends recordings to a new
third-party service.

## Tests

```sh
npm exec -- vitest run tests/audio-player-utils.test.ts
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5177 npm exec -- playwright test tests/e2e/audio-player.spec.ts
```

The browser tests use local generated audio and mocked APIs; point them at a
local Vox build/preview. They cover genuine canvas waveforms, six channels,
playback, drag/keyboard/transcript seeking, source switching, graceful failures,
PCM-derived duration fallback, and mobile touch scrubbing.
Additional regressions cover PCM encodings and malformed files, safe unsupported
format handling, transcript limits, stalled-playback pause, and speed preservation
when the native media source reloads without remounting.
Canvas bounds are tested with 32 channels, 8x zoom, and DPR 2. Browser tests also
cover deferred waveform requests and unknown-duration native-control fallback.
