# Browser Assistance Integration

Implementation and maintained operating contract:
[Live Browser Assistance](../docs/browser-assistance.md).

Follow-up implemented against aeval v0.5.1: [Encrypted Account Sessions And
Assisted Login](2026-11-17-auth-session-persistence-and-assisted-login.md).
It owns the current Runtime/Brokered persistence and staged-login role split;
historical engine-version descriptions below are not the current release pin.

The implementation integrates the aeval v0.4.5 protocol-v1 inspection/assistance
milestone reviewed in the November 10-11 cross-project design. It resolves the
Vox review's authority, broker placement, bounded-deadline, cancellation and
ordered-input requirements. Viewer access follows credential ownership or the
exact organization's secret-management authority, never mere job visibility.

The November 14 update pins binary and runtime data to v0.4.5, adds safe live
readiness feedback and final outcomes, and labels the original evaluation tab.
The engine restores that target once and retries delayed rendering within the
original assistance deadline; a successful command acknowledgment is not a
successful readiness check. Setup failures remain primary when empty-run
analysis also fails. See the maintained contract for rollout and regression tests.

The recorder/LLM milestone remains explicitly deferred. Browser action schemas
alone would not secure generated flows: any future work must separately resolve
prompt/data trust, secret scope, approved target/navigation policy, executable
action admission, and owner review before saving or running generated content.

Owner-based multi-Core routing is implemented with PostgreSQL ownership leases
and shared viewer grants, local execution on a single Core, and authenticated,
generation-fenced forwarding between replicas. Connections, frames and broker
keys are not persisted/replicated. The maintained document covers configuration,
reconnects and broker re-registration rather than promising transparent failover.

The integration does not claim ten-minute broker holds, measurement-validity
annotations, zero active-viewer overhead, or distributed unrelated Core features.
Those limits and required rollout/testing steps live in the linked document.
