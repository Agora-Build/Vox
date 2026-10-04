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
  decoding; native audio playback can still work without the waveform.
- The decoded file determines the number of waveform lanes, not `channels`.
  `channels` supplies optional labels and CSS colors; unlabeled lanes use
  numbered labels. Mono, stereo, and multichannel files share the same module.
- Transcript `start` and `end` are seconds relative to this recording, not the
  whole job. `channel` is zero-based. Overlapping speech is supported.
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
canvases. Peak extraction runs in a worker; canvases redraw for data, size, or
theme changes. Zoom supports 1x, 2x, 4x, and 8x with horizontal scrolling.

Dragging pauses audio and previews a position. Releasing commits one seek and
resumes only if playback was running before the drag. Touch supports horizontal
scrubbing while preserving vertical page scrolling. The timeline is keyboard
accessible: arrows seek 5 seconds, Page Up/Down seek 10 seconds, Home/End jump to
the beginning/end, and Space toggles playback. Clicking a transcript seeks to
its start. Scrolling the transcript turns off automatic following.

Waveform downloads are capped at 64 MiB, including responses without a
Content-Length header. Larger files, failed CORS requests, and unsupported
decoding formats show a clear message instead of a fabricated waveform; audio
controls remain available when the browser can play the file. Decoding loads
the recording into memory, so this is not a streaming waveform implementation.

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
decoded-duration fallback, and mobile touch scrubbing.
