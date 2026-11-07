# Agent condition events

Status: implementation on `feat/agent-condition-events-20261107`; not deployed.

## Purpose and scope

The job detail card is **Events**, not Network timeline. Network changes are one
category of conditions that can affect an evaluation. Host CPU and memory are
additional categories; the event model can gain other explicitly validated
categories later. This is diagnostic telemetry, not an arbitrary log ingestion
API, an LLM decision, or a notification-delivery implementation.

The initial network tags remain frozen at claim for filtering and grouping.
Measurements belong in typed event `data`, never in mutable baseline tags.
Event retention and telemetry rejection never invalidate an authorized evaluation
result. Lease, agent, job and Core claim timestamp remain the execution fence;
there is no new attempt ID. The network-specific contract remains maintained in
`2026-10-22-network-tags-design.md`.

## Version 1 host rules

| Condition | Trigger | Recovery / rearming |
| --- | --- | --- |
| CPU high | Machine CPU above 80% for 30 continuous seconds | Below 75% for 30 continuous seconds |
| Memory high | Machine memory above 80% for 30 continuous seconds | Below 75% for 30 continuous seconds |
| CPU/memory rising quickly | At least +20 percentage points over five minutes | Rise below 15 points for 30 seconds before another alert |

Rules are fixed, versioned defaults in `shared/host-resources.ts`; there is no
admin editor or per-flow rule override in this first implementation. Exactly 80%
does not trigger high usage; exactly 75% does not clear an active warning. A
relative 20% increase, such as 40% to 48%, is not a 20-point increase. A rise from
10% to 30% is informational, not by itself a high-usage warning.

Emit condition transitions, not one alert per sample. Recovery includes the
episode peak and duration. Sampling stays active between jobs to warm the
five-minute window. Conditions active at claim are recorded when currently
above the trigger; pre-job historical events are not replayed into the job.
Without a full five-minute sample window, the rise rule waits, never inventing
a baseline. A missing sample, sampler restart or interval over five seconds
resets the evidence window; no rise or sustained threshold crosses a gap.

## Measurement and host support

Linux CPU uses successive aggregate `/proc/stat` counters, normalized to 0-100%
across all cores; guest counters are not double-counted. Idle and I/O-wait ticks
are not busy CPU. Memory is `100 * (1 - MemAvailable / MemTotal)`, not raw free
memory, so reclaimable caches do not automatically look like pressure.

Native Linux agents read these host counters. Docker agents require the
unprivileged `scripts/vox-network-monitor.py` host service and its existing
read-only status-directory mount. Never silently substitute container metrics.
The host file adds bounded `resources` history, independently of network
availability. No additional privileges, tokens, listeners or external requests
are introduced. Only percentages and times leave the sampler; no process names,
command lines or raw host-memory sizes enter event reports.

The local rolling sample window is at least five minutes and is **separate**
from the two-minute queue of unacknowledged event details. The Python sampler
keeps at most 310 resource samples alongside its existing 128 network transitions.
Old samplers, unsupported platforms (including macOS resource sampling in v1),
missing/stale/malformed files and missing MemAvailable produce unavailable
coverage, never a fabricated healthy status. Existing macOS network monitoring
is unchanged.

## Protocol, persistence and safety

An additive version 2 of the existing `networkReport` envelope carries typed
`host_start`, `host_high`, `host_rise`, `host_recovered`, `host_gap` and `host_end`
events with a separate `resources` continuity/high-usage/rise summary. Version 1
network-only reports stay valid; they cannot carry host events. The legacy wire
field name avoids a second competing acknowledgment protocol.

All events use the existing lease-global increasing sequence and submitted-batch
ACK/rejection rules. Accepted IDs are removed; in-flight and other pending events
are preserved. After two minutes without delivery, detail eviction never clears
sticky high-usage/rise summaries, and coverage remains incomplete. Shared event
sequence gaps conservatively prevent complete coverage; a host sampling gap alone
does not imply a network sampling gap, or vice versa.

Schema 68 (`0067_agent_resource_events.sql`) adds nullable typed event `data`
and a separate resource summary to existing claim state. No baseline tags are
rewritten, and no historical host coverage is backfilled. Resource payloads are
strictly validated, bounded and included in immutable conflict detection using
structural equality rather than JSON property order. Persist events, coverage
and final results under the existing transaction/savepoint safety rules.

The new authorized `GET /api/eval-jobs/:id/events?cursor=<id>` returns the shared
stream and independent network/resource summaries. It uses the same job-view
policy, private-job checks and pagination bounds as the original endpoint. The
legacy `/network-events` endpoint remains network-only. Neither exposes leases,
agent identity, IPs or local fingerprints.

## UI and Strict policy

`JobEvents` owns the generalized timeline and shared presentation helpers. Show
All / Network / CPU / Memory filters, readable offsets, source-neutral event
labels, distinct warning/recovery markers and expandable technical details.
The entire Events card starts folded on each page load. Its heading toggles
the summaries and timeline with mouse or keyboard. Fetch and poll event history
only while expanded; folding the card does not stop agent-side monitoring.
On evaluation results, Events sits immediately above Screenshots, after the
metrics and recordings. Jobs without results still show Events. The shared
result view also starts Artifact Files folded, with the uploaded file count
visible and the file table available through its heading toggle.
Show network tags on Initial and connection changes; do not repeat unknown
network tags on every monitoring or host event. End means monitoring ended,
not that a successful evaluation failed or was interrupted.

An initial network gap means no usable first sample, not proof of an Internet
outage. Incomplete completed runs do not promise eventual verification. Present
network and host coverage separately; a network-verified run is not advertised
as a fully verified healthy machine when host telemetry is absent.

**Strict eligibility is unchanged in this release:** complete network coverage
and no detected network change. CPU/memory conditions are diagnostic. Broadening
Strict to exclude sustained resource pressure needs a separate explicit policy
decision and rollout, including historical/older-agent coverage. Rapid rises
alone must not silently exclude low-utilization runs. Host issues never fail
the evaluation itself. No notification rules are automatically enabled.

## Rollout and verification

Deploy Core/schema 68 first, then the updated daemon, then restart the updated
host sampler. Older agents continue evaluating without host coverage. An older
Core rejects v2 telemetry, so do not roll out the daemon first. Container agents
without the host sampler show unavailable host metrics.

Regression coverage includes deterministic rule timing, threshold boundaries,
recovery/rise hysteresis, native/Python CPU-counter parity, stale/missing host
observations, duplicate acknowledgments, sticky summaries, lease/claim fencing,
JSON property-order independence, result survival on bad resource reports,
legacy API compatibility, and desktop/mobile timeline interactions.

Validated on 2026-11-07 in disposable isolated containers with the full
`scripts/full-tests-run.sh`: 3,778 unit/integration tests, 29 audio checks and
270 browser tests passed; the suite skipped 84 unit/integration and 35 browser
tests. Core/client build, Core and daemon TypeScript checks, changed-module lint
and whitespace checks also passed. This is local validation, not a deployment.
The default-folded UI follow-up passed 24 desktop/mobile browser regressions,
TypeScript, lint and whitespace checks.
The Events placement and folded Artifact Files follow-up passed 66 browser
regressions (including the shared recording player), TypeScript, lint and
whitespace checks.
