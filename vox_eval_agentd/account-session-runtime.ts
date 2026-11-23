import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { accountProvider, acceptsProviderAccountState } from "../shared/account-session-setup";
import { ACCOUNT_CHECKPOINT_LIMITS } from "../shared/account-session-protocol";
import { AccountCheckpointConsumer, accountCheckpointReply } from "./account-checkpoints";
import { createAccountWorkspace } from "./account-workspace";

export type AccountSessionFetch = (path: string, options: RequestInit & { timeoutMs?: number }) => Promise<Response>;

/** One engine invocation, not a whole-evaluation authentication retry. */
export async function prepareAccountRuntime(input: {
  scenarioFile: string; sessionId: string; jobId: number; leaseId: string; startedAt: string;
  credentialRevision: string | null;
  fetch: AccountSessionFetch; cancelled: () => boolean;
}) {
  const document = yaml.load(fs.readFileSync(input.scenarioFile, "utf8")) as { steps?: Array<{ type?: string; platform_id?: string; mode?: string; params?: Record<string, unknown> }> };
  const setups = (document?.steps ?? []).filter(step => step?.type === "platform.setup" &&
    (step.params?.mode ?? step.mode) === "account" && typeof step.params?.storage_file === "string" && step.params.storage_file.trim());
  if (!setups.length) return null;
  const workspace = createAccountWorkspace();
  const abort = new AbortController();
  let grant: string | null = null, timer: NodeJS.Timeout | null = null, consumer: AccountCheckpointConsumer | null = null;
  const endpoint = `/api/eval-agent/jobs/${input.jobId}/account-session`;
  try {
    // Even unsupported/literal account setups never reuse an unscoped container
    // file. They get private files but cannot opt arbitrary values into Core storage.
    for (let i = 0; i < setups.length; i++) setups[i].params!.storage_file = path.join(workspace.root, `storage-${i}.json`);
    const setup = setups.length === 1 ? setups[0] : null;
    const storageFile = setup?.params?.storage_file as string | undefined;
    if (setup && storageFile && accountProvider(setup.platform_id ?? "") && input.credentialRevision) {
      try {
        const response = await input.fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(5000), timeoutMs: 5000,
          body: JSON.stringify({ sessionId: input.sessionId, leaseId: input.leaseId, startedAt: input.startedAt,
            credentialRevision: input.credentialRevision }) });
        const body = await response.json();
        if (response.ok) {
          if (typeof body.state === "string" && Buffer.byteLength(body.state) <= ACCOUNT_CHECKPOINT_LIMITS.snapshotBytes &&
              acceptsProviderAccountState(setup.platform_id!, JSON.parse(body.state))) fs.writeFileSync(storageFile, body.state, { mode: 0o600 });
          if (body.status === "ready" && typeof body.grant === "string") grant = body.grant;
        }
      } catch { /* A cache outage does not fail an otherwise authorized eval. */ }
      if (grant) {
        consumer = new AccountCheckpointConsumer({ storageFile, sessionId: input.sessionId, signal: abort.signal,
          authorized: async () => !input.cancelled(), acceptsState: state => acceptsProviderAccountState(setup.platform_id!, state),
          deliver: async (record, state, signal) => {
            const response = await input.fetch(`${endpoint}/checkpoints`, { method: "POST", signal, timeoutMs: 5000,
              body: JSON.stringify({ grant, record, state }) });
            if (response.status === 401 || response.status === 403) { abort.abort(); return { status: "rejected" }; }
            return accountCheckpointReply(await response.json());
          } });
        timer = setInterval(() => { void consumer!.poll(); }, 1000); timer.unref();
      }
    }
    const scenarioFile = path.join(workspace.root, path.basename(input.scenarioFile));
    fs.writeFileSync(scenarioFile, yaml.dump(document, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
    return { scenarioFile, async finish() {
      if (timer) clearInterval(timer);
      try { await consumer?.finish(); }
      finally {
        abort.abort();
        if (grant) {
          try { await input.fetch(`${endpoint}/release`, { method: "POST", signal: AbortSignal.timeout(1000), timeoutMs: 1000,
            body: JSON.stringify({ grant }) }); } catch { /* Fences expire without erasing the last good state. */ }
        }
        workspace.close();
      }
    } };
  } catch (error) { if (timer) clearInterval(timer); abort.abort(); workspace.close(); throw error; }
}
