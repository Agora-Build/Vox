// Tools → Analyze on the eval agent (design 2026-09-30). An uploaded stereo
// WAV (left = user, right = agent) is the same input the phone path gives
// `aeval analyze`: one mixed recording at <session>/recordings/recording.wav.
// So it is staged the same way and analyzed with the same (phone) preset.
// Network and aeval are injected, so this runs in tests without either.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseWavHeader, analyzeWavError } from '../shared/wav';
import { enrichMetricsWithTurns, parseTurnsJson } from './chunking';

export interface AnalyzeUploadDeps {
  workDir: string;
  /** Write the uploaded recording to `dest`. */
  download: (dest: string) => Promise<void>;
  /** `aeval analyze <sessionDir>`; throws on a non-zero exit. */
  analyze: (sessionDir: string) => Promise<void>;
  /** The metrics aeval wrote, or null when there are none. */
  parseMetrics: (sessionDir: string) => Record<string, unknown> | null;
}

const HEADER_BYTES = 1 << 20; // the WAV header check needs only the start

export async function runAnalyzeUpload(deps: AnalyzeUploadDeps): Promise<{ result: Record<string, unknown> }> {
  const sessionDir = deps.workDir;
  const recordings = path.join(sessionDir, 'recordings');
  try {
    fs.mkdirSync(recordings, { recursive: true });
    const wavPath = path.join(recordings, 'recording.wav');
    await deps.download(wavPath);

    // Core checked it at upload; check again here, where a bad file would
    // otherwise cost a full aeval run.
    const size = fs.statSync(wavPath).size;
    const fd = fs.openSync(wavPath, 'r');
    const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const problem = analyzeWavError(parseWavHeader(new Uint8Array(head.buffer, head.byteOffset, head.length), size), size);
    if (problem) throw new Error(problem);

    await deps.analyze(sessionDir); // throws → the job fails (failure policy)
    const result = deps.parseMetrics(sessionDir);
    if (!result) throw new Error('analysis produced no usable metrics');

    // Transcripts and turn boundaries onto each turn, as the phone path does (#206).
    const turnsFile = path.join(sessionDir, 'analysis', 'turns.json');
    const rawData = result.rawData as Record<string, unknown> | undefined;
    if (rawData && fs.existsSync(turnsFile)) {
      const turns = parseTurnsJson(fs.readFileSync(turnsFile, 'utf-8'));
      if (turns) enrichMetricsWithTurns(rawData, turns);
    }
    // A recording measures none of these: say so, rather than send the daemon's
    // placeholder defaults as if they were results.
    result.networkResilience = null;
    result.naturalness = null;
    result.noiseReduction = null;

    return { result };
  } finally {
    // Nothing of an analysis stays on the agent or leaves as an artifact: the
    // recording and aeval's output (transcripts included) are the uploader's.
    // What the pages show — metrics, turns, transcripts — is in the result.
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

/** What this agent can do beyond web evals, for register/heartbeat. */
export function capabilitiesFor(has: { dialf: boolean; aeval: boolean }): string[] {
  return [...(has.dialf ? ['phone'] : []), ...(has.aeval ? ['analyze'] : [])];
}

let aevalRuns: boolean | null = null;
/** Whether `aeval` runs on this host. Checked once: it doesn't come and go. */
export function aevalOnPath(): boolean {
  if (aevalRuns === null) {
    aevalRuns = spawnSync('aeval', ['--version'], { stdio: 'ignore', timeout: 30_000 }).status === 0;
  }
  return aevalRuns;
}
