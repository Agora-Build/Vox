# Browser Assistance Integration

Implementation and maintained operating contract:
[Live Browser Assistance](../docs/browser-assistance.md).

The implementation integrates the aeval v0.4.4 protocol-v1 inspection/assistance
milestone reviewed in the November 10-11 cross-project design. It resolves the
Vox review's authority, broker placement, bounded-deadline, cancellation and
ordered-input requirements. Viewer access follows credential ownership or the
exact organization's secret-management authority, never mere job visibility.

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
