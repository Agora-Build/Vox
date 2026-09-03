# Clash Objective Ranking (v1, no judge) — Design Spec

**Date:** 2026-07-16
**Status:** Approved for planning
**Scope:** Make Clash decide real match winners from objective, audio-derived signals and feed them into Elo. No LLM judge, no audience voting (both deferred to v2).

## Problem

Clash runs head-to-head voice-agent matches (Agent A vs Agent B, moderated by an Agora ConvoAI agent) and is meant to rank agents by Elo. Today it cannot decide a winner:

- `computeMetrics` (`vox_clash_runner/audio/observer.ts`) is a stub — it returns `responseLatencyMedian: null` and all other turn-level fields null; only `audioRms` / `talkTimeSeconds` are real.
- The server winner rule (`server/routes.ts` `/api/clash-runner/complete`, and `updateClashEloRatings`) requires `latA != null && latB != null` — which is never true — so `winnerId` is always `null`.
- **Result: every match is a draw and Elo never moves.** The leaderboard, the entire point of Clash, is inert.

## Goal

Produce a real per-match outcome (win / loss / draw) from signals extractable from the match audio **without STT or a semantic judge**, blend them into a transparent composite score, and drive the existing Elo pipeline from that outcome.

**Non-goals (v2, explicitly deferred):** LLM-as-judge (coherence, argument quality, relevance), audience voting, Bradley-Terry aggregation with confidence intervals, intentional-interrupt reaction-time metrics.

## What is extractable from Clash audio

The runner has three perfectly-isolated mono captures per match (s16le, `SAMPLE_RATE`):

- `agent_a.raw` — Agent A output (`Sink_A_Out.monitor`)
- `agent_b.raw` — Agent B output (`Sink_B_Out.monitor`)
- `moderator_out.raw` — moderator (RTC tee)

`computePcmStats` already performs 100 ms-window VAD (RMS per window vs `SILENCE_RMS_THRESHOLD`). From per-channel VAD timelines we can objectively derive: response latency (turn-taking gaps), turn-taking success, overlap/barge-in, and talk-time balance. We **cannot** derive (without a judge): coherence, argument quality, staying on topic, or the intent behind an interruption. Those are v2.

## Architecture

Two layers, with a clean split of responsibility:

1. **Runner** extracts **raw objective signals** per agent from the captures and reports them (unchanged transport: `metricsA` / `metricsB` in the `POST /api/clash-runner/complete` body).
2. **Server** owns the **blend, winner rule, and Elo**. Weights and thresholds live in one server-side module so they are versionable and changeable without redeploying runner containers. The composite score is computed from the reported metrics, the winner is derived from the two composites, and Elo consumes that single outcome.

This keeps the signal-processing (runner, needs the raw audio) separate from the ranking policy (server, a product decision).

## Layer 1 — Signal extraction (runner, `observer.ts`)

### Speech timeline

For each of `agent_a.raw` and `agent_b.raw`, produce a boolean per-window activity array using the existing 100 ms VAD windowing (factor the per-window active flags out of `computePcmStats` into a reusable helper; keep `computePcmStats` behavior intact).

### Turn segmentation (pure function over two timelines)

Constants (named, tunable):

- `WINDOW_MS = 100` — VAD window (matches existing).
- `TURN_GAP_MERGE_MS = 300` — merge speech segments separated by less than this (do not split a turn on a natural breath/pause).
- `MIN_SEGMENT_MS = 300` — drop segments shorter than this (ignore blips/noise).
- `RESPONSE_WINDOW_MS = 5000` — an agent must begin responding within this long after the opponent's turn ends to count as a successful response.
- `MAX_RESPONSE_LATENCY_MS = 8000` — response-latency samples above this are discarded (treated as a non-response, not a latency measurement).

Algorithm:

1. **Segments:** collapse each channel's window array into contiguous active runs; merge runs separated by `< TURN_GAP_MERGE_MS` of silence; drop runs `< MIN_SEGMENT_MS`. Each surviving run is a **turn** `{ speaker, startMs, endMs }`.
2. **Interleave** A's and B's turns into one timeline ordered by `startMs`.
3. **Response latency:** for each turn `Y` whose speaker differs from the immediately preceding turn `X`, `latency = Y.startMs − X.endMs`. Keep if `0 < latency <= MAX_RESPONSE_LATENCY_MS`. Collect per agent → **median**, **population SD**, **p95** (same formulas the eval daemon uses; median = true middle, SD = `sqrt(Σ(xi−mean)²/n)`).
4. **Overlap:** `overlapPercent` = windows where both channels active / windows where at least one active. A per-agent **barge-in** = a turn `Y` that starts while the opponent's current turn is still ongoing (`Y.startMs < X.endMs`).
5. **Turn success rate (TSR):** iterate opponent turns that end (each is an **opportunity** for this agent). The agent **succeeds** if it starts a turn within `RESPONSE_WINDOW_MS` after the opportunity ends **and** that response was not a barge-in; it **fails** on dead-air (no qualifying response) or barge-in. `TSR = successes / opportunities`; if `opportunities == 0`, `TSR = null` (not enough conversation to score).

### Reported metrics (per agent)

Populate `ObserverMetrics` for real (currently null):

- `responseLatencyMedian`, `responseLatencySd`, `responseLatencyP95`
- `turnCount` (number of this agent's turns)
- `overlapPercent`
- `turnSuccessRate` (**new field**)
- `audioRms`, `talkTimeSeconds` (unchanged, already real)
- `interruptLatencyMedian` / `interruptLatencySd` / `ttftMedian` remain **null** (v2/judge territory).

The turn-metric computation must run **before** the raw files are consumed/deleted by `stopRecording`. Extend the recording stop path (or add a sibling computation) so the raw buffers are analyzed for turns as well as audio-health.

## Layer 2 — Blend, winner, Elo (server)

New server-side module (e.g. `server/clash-ranking.ts`) holding the policy so it is testable and versionable in one place.

### Normalization (each → 0..1, 1 = best)

Constants (named, tunable, published):

- Turn success: `tsrScore = TSR` (already 0..1).
- Responsiveness: `latencyScore = clamp(1 − (medianLatMs − LAT_FLOOR_MS) / (LAT_CAP_MS − LAT_FLOOR_MS), 0, 1)`, with `LAT_FLOOR_MS = 200`, `LAT_CAP_MS = 3000`.
- Turn-taking discipline: `overlapCleanliness = 1 − min(overlapFraction / OVERLAP_CAP, 1)`, with `OVERLAP_CAP = 0.5`.

### Composite

```
composite = 0.50 · tsrScore + 0.30 · latencyScore + 0.20 · overlapCleanliness   // 0..1
```

Weights: `W_TSR = 0.50`, `W_LATENCY = 0.30`, `W_OVERLAP = 0.20`.

**Missing-signal handling:** if a component is null (e.g. `TSR` null because no opportunities, or latency null because no valid turn pairs), drop that component and **renormalize the remaining weights** to sum to 1. If an agent has *no* usable signals at all (e.g. total silence / dead pipeline), its composite is `0`.

### Winner rule

- `DRAW_MARGIN = 0.05`.
- If `|compositeA − compositeB| < DRAW_MARGIN` → **draw** (`winnerId = null`, both `sa = sb = 0.5`).
- Else the higher composite wins.
- If the match reported an `error`, or neither agent produced any signal → no Elo update (as today for errored matches).

### Elo

- Keep the existing **online Elo, `K = 32`**, expected-score formula, and `clash_elo_ratings` counters.
- `updateClashEloRatings` is refactored to take the **composite outcome** (win/loss/draw) rather than recomputing from latency. One outcome, computed once in `/complete`, drives both `clashMatches.winnerId` and Elo.

## Data model / migration

Add two columns to `clash_results` (both nullable real/float):

- `turn_success_rate` (real) — the reported per-agent TSR.
- `composite_score` (real) — the composite as decided at completion time (stored as-computed, consistent with Vox's immutable-snapshot philosophy; survives later weight changes).

One migration file (`migrations/00XX_clash_composite_ranking.sql`), plain `ALTER TABLE ADD COLUMN`, **registered in the `MIGRATIONS` array in `server/migrate.ts`**. Update `shared/schema.ts` (`clashResults` table + insert schema) and regenerate types. No changes to `clash_elo_ratings` or `clash_matches`.

## Transparency (published methodology)

The blend formula, normalization bands, and weights are published as the Clash ranking methodology (consistent with the existing Terms/leaderboard language that rankings derive solely from published methodology). The composite is deterministic and reproducible from the reported signals.

## Testing

- **Runner unit tests (`tests/clash-audio.test.ts` additions), pure functions on synthetic timelines:**
  - Window-activity extraction matches `computePcmStats` on the same buffer.
  - Turn segmentation: gap-merge (< 300 ms merges), blip-drop (< 300 ms dropped), min-segment behavior.
  - Response latency: clean alternation yields expected gaps; median/SD/p95 math; out-of-band samples (`> 8 s`, `<= 0`) discarded.
  - TSR: clean alternation → 1.0; dead-air opponent turns → failures; barge-in → failure; `opportunities == 0` → null.
  - Overlap: silence → 0; full overlap → 1; partial → expected fraction.
- **Server unit tests (new, on `server/clash-ranking.ts`):**
  - Normalization edges (latency at/below floor → 1, at/above cap → 0; overlap at/above cap → 0).
  - Composite weighting on known inputs.
  - Missing-signal renormalization (null TSR drops to latency+overlap reweighted to 1; all-null → 0).
  - Winner rule: clear win, draw within margin, error → no update, both-silent → no update.
- No new live/external dependencies; everything derives from PCM the runner already captures.

## Rollout

- Single PR: runner (`observer.ts` + any `config.ts` constants) + server (`clash-ranking.ts`, `routes.ts` `/complete`, `updateClashEloRatings`) + schema + migration + tests.
- **Runner containers must be upgraded** (`vox-upgrade.sh`) for the new signal extraction to take effect; server auto-deploys from main. Until runners are upgraded they report null turn metrics → those matches fall back to draw (same as today), so there is no regression during the rollout window.
- Branch + squash-merge on the user's mark; `npm run check` + `npm test` before push.

## Known gaps after v1

- Ranks conversational **mechanics**, not **content** — an agent that converses fluently but says nonsense can still score well. This is the explicit reason the LLM judge (v2) exists.
- Online Elo is order-dependent; Bradley-Terry with confidence intervals arrives with the v2 aggregation rework.
- No audience signal yet.
