# Workflow / Eval-Set Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a strict, validated disjoint contract where workflows own platform setup/teardown + connection params and eval sets own the test body (`scenario`), with the daemon merging them at run time.

**Architecture:** Two flat JSONB configs. Server-side role validators reject cross-ownership keys (400). `mergeEvalConfig` asserts the key sets are disjoint, then spreads. A one-time SQL migration strips `scenario` from existing workflow rows. The daemon's merge/chunk engine (already implemented on this branch) is unchanged; we add test coverage. Seed data and the workflow UI are reshaped to support setup/teardown steps.

**Tech Stack:** TypeScript, Express, Drizzle ORM (Postgres JSONB), Vitest, React + shadcn/ui, js-yaml.

**Spec:** `designs/2026-06-10-workflow-evalset-separation-design.md`

---

## File Structure

- `server/storage.ts` — replace `validateEvalConfig` with `validateWorkflowConfig` + `validateEvalSetConfig`; make `mergeEvalConfig` assert disjoint. (pure functions, unit-tested)
- `server/routes.ts` — wire each create/update/clone route to the role-appropriate validator.
- `migrations/0010_strip_workflow_scenario.sql` — new; strips `scenario` from workflow configs.
- `server/migrate.ts` — register the new migration (version 11).
- `scripts/seed-data.ts` — reshape: shared eval set body + LiveKit and Agora workflows with `stepsPrefix`/`stepsSuffix`, no `scenario`.
- `client/src/pages/console-workflows.tsx` — add `stepsPrefix`/`stepsSuffix` editing.
- `client/src/pages/console-evalsets.tsx` — body-only hint.
- `tests/storage.test.ts` — unit tests for the two validators + disjoint merge.
- `tests/eval-chunking.test.ts` — tests for `composeScenarioYaml` + chunk-vs-compose decision.
- `tests/api.test.ts` — integration tests for the validation boundary.

---

## Task 1: Role-based config validators + disjoint merge

**Files:**
- Modify: `server/storage.ts:162-193` (replace `validateEvalConfig`, update `mergeEvalConfig`)
- Test: `tests/storage.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/storage.test.ts` (it already imports pure functions from `../server/storage`). Add the new symbols to the existing import at the top — change line 2 to:

```ts
import {
  hashToken,
  generateSecureToken,
  validateWorkflowConfig,
  validateEvalSetConfig,
  mergeEvalConfig,
} from '../server/storage';
```

Then append this block at the end of the file:

```ts
describe('Config separation validators', () => {
  describe('validateWorkflowConfig', () => {
    it('accepts framework + steps + connection params', () => {
      const r = validateWorkflowConfig({
        framework: 'aeval',
        stepsPrefix: '- type: platform.setup',
        stepsSuffix: '- type: platform.exit',
        url: 'https://example.com',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects scenario in a workflow', () => {
      const r = validateWorkflowConfig({ framework: 'aeval', scenario: 'name: x' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('eval set');
    });

    it('rejects an invalid framework', () => {
      const r = validateWorkflowConfig({ framework: 'nope' });
      expect(r.valid).toBe(false);
    });

    it('rejects non-string stepsPrefix', () => {
      const r = validateWorkflowConfig({ stepsPrefix: 123 });
      expect(r.valid).toBe(false);
    });

    it('accepts null/undefined', () => {
      expect(validateWorkflowConfig(null).valid).toBe(true);
      expect(validateWorkflowConfig(undefined).valid).toBe(true);
    });
  });

  describe('validateEvalSetConfig', () => {
    it('accepts a scenario body', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x\nsteps: []' });
      expect(r.valid).toBe(true);
    });

    it('rejects framework in an eval set', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x', framework: 'aeval' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('workflow');
    });

    it('rejects stepsPrefix in an eval set', () => {
      const r = validateEvalSetConfig({ stepsPrefix: '- type: platform.setup' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('workflow');
    });

    it('rejects non-string scenario', () => {
      const r = validateEvalSetConfig({ scenario: { name: 'x' } });
      expect(r.valid).toBe(false);
    });
  });

  describe('mergeEvalConfig', () => {
    it('spreads disjoint configs', () => {
      const merged = mergeEvalConfig(
        { framework: 'aeval', stepsPrefix: 'a' },
        { scenario: 'b' },
      );
      expect(merged).toEqual({ framework: 'aeval', stepsPrefix: 'a', scenario: 'b' });
    });

    it('throws on overlapping keys', () => {
      expect(() =>
        mergeEvalConfig({ scenario: 'a' }, { scenario: 'b' }),
      ).toThrow(/share keys/);
    });

    it('tolerates null inputs', () => {
      expect(mergeEvalConfig(null, { scenario: 'b' })).toEqual({ scenario: 'b' });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storage.test.ts -t "Config separation"`
Expected: FAIL — `validateWorkflowConfig is not a function` (and the others undefined).

- [ ] **Step 3: Implement the validators and disjoint merge**

In `server/storage.ts`, replace the entire `validateEvalConfig` function (lines 162-193, ending at the close of `mergeEvalConfig`) with:

```ts
// Keys owned exclusively by the eval set (the test body).
const EVALSET_ONLY_KEYS = ["scenario"] as const;
// Keys owned exclusively by the workflow (platform setup + connection).
const WORKFLOW_ONLY_KEYS = ["framework", "app", "stepsPrefix", "stepsSuffix"] as const;

export function validateWorkflowConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  const c = config as Record<string, unknown>;
  for (const k of EVALSET_ONLY_KEYS) {
    if (k in c) {
      return { valid: false, error: `'${k}' belongs to the eval set, not the workflow` };
    }
  }
  if (c.framework !== undefined && c.framework !== "aeval" && c.framework !== "voice-agent-tester") {
    return { valid: false, error: "Framework must be 'aeval' or 'voice-agent-tester'" };
  }
  if (c.app !== undefined && typeof c.app !== "string") {
    return { valid: false, error: "Config app must be a string" };
  }
  if (c.stepsPrefix !== undefined && typeof c.stepsPrefix !== "string") {
    return { valid: false, error: "Config stepsPrefix must be a string" };
  }
  if (c.stepsSuffix !== undefined && typeof c.stepsSuffix !== "string") {
    return { valid: false, error: "Config stepsSuffix must be a string" };
  }
  if (JSON.stringify(config).length > MAX_CONFIG_SIZE) {
    return { valid: false, error: "Config too large (max 100KB)" };
  }
  return { valid: true };
}

export function validateEvalSetConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  const c = config as Record<string, unknown>;
  for (const k of WORKFLOW_ONLY_KEYS) {
    if (k in c) {
      return { valid: false, error: `'${k}' belongs to the workflow, not the eval set` };
    }
  }
  if (c.scenario !== undefined && typeof c.scenario !== "string") {
    return { valid: false, error: "Config scenario must be a string" };
  }
  if (JSON.stringify(config).length > MAX_CONFIG_SIZE) {
    return { valid: false, error: "Config too large (max 100KB)" };
  }
  return { valid: true };
}

export function mergeEvalConfig(
  workflowConfig: unknown,
  evalSetConfig: unknown,
): Record<string, unknown> {
  const wf = (workflowConfig as Record<string, unknown>) || {};
  const es = (evalSetConfig as Record<string, unknown>) || {};
  const overlap = Object.keys(wf).filter((k) => k in es);
  if (overlap.length > 0) {
    throw new Error(`Workflow and eval set configs share keys: ${overlap.join(", ")}`);
  }
  return { ...wf, ...es };
}
```

(`MAX_CONFIG_SIZE` is already defined above this block — keep it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/storage.test.ts -t "Config separation"`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add server/storage.ts tests/storage.test.ts
git commit -m "feat: role-based eval config validators + disjoint merge

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 2: Wire validators into routes

**Files:**
- Modify: `server/routes.ts` (import line 3; call sites at 1265, 1327, 1515, 1569, 1637)
- Test: `tests/api.test.ts` (integration — requires local server running)

- [ ] **Step 1: Write the failing integration tests**

In `tests/api.test.ts`, add this `describe` block inside the main `describe('Vox API Tests', ...)` block (it has access to `adminSession`, `testProjectId`, `testProviderId`, `BASE_URL`, `authFetch`). Place it right after the `describe('Eval Set API', ...)` block:

```ts
  describe('Config separation enforcement', () => {
    it('rejects a workflow whose config has scenario', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Bad Workflow',
          visibility: 'public',
          projectId: testProjectId,
          providerId: testProviderId,
          config: { framework: 'aeval', scenario: 'name: x' },
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('eval set');
    });

    it('rejects an eval set whose config has framework', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Bad Eval Set',
          visibility: 'public',
          config: { scenario: 'name: x', framework: 'aeval' },
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('workflow');
    });

    it('accepts a valid disjoint workflow + eval set', async () => {
      const wf = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Good Workflow',
          visibility: 'public',
          projectId: testProjectId,
          providerId: testProviderId,
          config: { framework: 'aeval', stepsPrefix: '- type: platform.setup' },
        }),
      });
      expect(wf.ok).toBe(true);

      const es = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Good Eval Set',
          visibility: 'public',
          config: { scenario: 'name: x\nsteps: []' },
        }),
      });
      expect(es.ok).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Ensure the local server is running (`./scripts/dev-local-run.sh start`), then:
Run: `npx vitest run tests/api.test.ts -t "Config separation enforcement"`
Expected: FAIL — the workflow-with-scenario create currently returns 200 (old `validateEvalConfig` allows `scenario`).

- [ ] **Step 3: Update the route imports and call sites**

In `server/routes.ts` line 3, change the import — replace `validateEvalConfig` with the two new names:

```ts
import { storage, hashToken, generateSecureToken, generateEvalAgentToken, mergeEvalConfig, validateWorkflowConfig, validateEvalSetConfig, encryptValue, decryptValue, isEncryptionConfigured } from "./storage";
```

Then change each `const v = validateEvalConfig(config);` call to the role-appropriate validator:

- Line ~1265 (`POST /api/workflows`): `const v = validateWorkflowConfig(config);`
- Line ~1327 (`PATCH /api/workflows/:id`): `const v = validateWorkflowConfig(config);`
- Line ~1515 (`POST /api/eval-sets`): `const v = validateEvalSetConfig(config);`
- Line ~1569 (`PATCH /api/eval-sets/:id`): `const v = validateEvalSetConfig(config);`
- Line ~1637 (`POST /api/eval-sets/:id/clone`): `const v = validateEvalSetConfig(config);`

(Use `grep -n "validateEvalConfig" server/routes.ts` to confirm all five are replaced; there should be zero remaining.)

- [ ] **Step 4: Run the tests to verify they pass**

Restart the dev server so the route change is picked up (`./scripts/dev-local-run.sh start` reloads via tsx), then:
Run: `npx vitest run tests/api.test.ts -t "Config separation enforcement"`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: no errors (confirms no stale `validateEvalConfig` references remain).

- [ ] **Step 6: Commit**

```bash
git add server/routes.ts tests/api.test.ts
git commit -m "feat: enforce workflow/eval-set config roles at the API boundary

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 3: One-time data migration

**Files:**
- Create: `migrations/0010_strip_workflow_scenario.sql`
- Modify: `server/migrate.ts:24-35` (MIGRATIONS array)

- [ ] **Step 1: Create the migration SQL**

Create `migrations/0010_strip_workflow_scenario.sql`:

```sql
-- Strip the eval-set-owned 'scenario' key from all workflow configs.
-- After the workflow/eval-set separation, the workflow owns only platform
-- setup/teardown + connection params; the test body (scenario) lives
-- exclusively in the eval set. The '-' operator removes a top-level jsonb key.
UPDATE workflows SET config = config - 'scenario' WHERE config ? 'scenario';
```

- [ ] **Step 2: Register the migration**

In `server/migrate.ts`, append to the `MIGRATIONS` array (after the `version: 10` entry, before the closing `];`):

```ts
  { version: 11, description: "strip scenario from workflow configs", file: "0010_strip_workflow_scenario.sql" },
```

- [ ] **Step 3: Apply and verify**

Run the migration runner against the local DB:

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate
```

Then confirm no workflow config still carries `scenario`:

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" \
  psql "postgresql://vox:vox123@localhost:5432/vox" \
  -c "SELECT count(*) FROM workflows WHERE config ? 'scenario';"
```

Expected: `count` = `0`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0010_strip_workflow_scenario.sql server/migrate.ts
git commit -m "feat: migration to strip scenario from workflow configs

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 4: Daemon merge-engine test coverage

The daemon's `composeScenarioYaml` + chunk-vs-compose logic already exists on this branch. This task adds tests; no production code changes.

**Files:**
- Modify: `tests/eval-chunking.test.ts` (import + new describe blocks)

- [ ] **Step 1: Write the failing tests**

In `tests/eval-chunking.test.ts`, add `composeScenarioYaml` to the import from `../vox_eval_agentd/chunking` (it is currently not imported). Then append:

```ts
import { composeScenarioYaml } from "../vox_eval_agentd/chunking";

describe("composeScenarioYaml", () => {
  it("wraps the body with prefix/suffix and preserves metadata", () => {
    const scenario: ParsedScenario = {
      name: "turn_taking_en",
      description: "desc",
      analysis: { preset: "medialab" },
      params: { lab: { suite: "turn_taking_en", case_id: "INT_BASIC" } },
      steps: [{ type: "lab.trace", sample_id: "INT_BASIC-001" }],
    };
    const prefix: ScenarioStep[] = [{ type: "platform.setup", platform_id: "agora" }];
    const suffix: ScenarioStep[] = [{ type: "platform.exit" }];

    const out = composeScenarioYaml(scenario, prefix, scenario.steps, suffix);
    const parsed = yaml.load(out) as ParsedScenario;

    expect(parsed.name).toBe("turn_taking_en");
    expect(parsed.description).toBe("desc");
    expect(parsed.analysis).toEqual({ preset: "medialab" });
    expect(parsed.params).toEqual({ lab: { suite: "turn_taking_en", case_id: "INT_BASIC" } });
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toEqual({ type: "platform.setup", platform_id: "agora" });
    expect(parsed.steps[1]).toEqual({ type: "lab.trace", sample_id: "INT_BASIC-001" });
    expect(parsed.steps[2]).toEqual({ type: "platform.exit" });
  });

  it("falls back to a default name when scenario has none", () => {
    const scenario = { steps: [] } as unknown as ParsedScenario;
    const out = composeScenarioYaml(scenario, [], [], []);
    const parsed = yaml.load(out) as ParsedScenario;
    expect(parsed.name).toBe("scenario");
  });
});

describe("chunk-vs-compose decision", () => {
  // Mirrors the daemon's `canChunk` predicate in executeAevalWithChunking:
  //   samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0
  const canChunk = (steps: ScenarioStep[]) => {
    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(steps);
    return samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0;
  };

  it("clean lab.trace body is chunkable", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "A-001", case_id: "INT_BASIC" },
      { type: "audio.play", corpus_id: "q1" },
      { type: "lab.trace", sample_id: "A-002", case_id: "INT_BASIC" },
      { type: "audio.play", corpus_id: "q2" },
    ];
    expect(canChunk(steps)).toBe(true);
  });

  it("control.for_each body is NOT chunkable (compose one file)", () => {
    const steps: ScenarioStep[] = [
      { type: "control.for_each", corpus_set: "three_questions_en", steps: [] },
    ];
    expect(canChunk(steps)).toBe(false);
  });

  it("body with trailing teardown is NOT chunkable via the fast path", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "A-001", case_id: "INT_BASIC" },
      { type: "audio.play", corpus_id: "q1" },
      { type: "platform.exit" },
    ];
    // extractSampleGroups pulls platform.exit into suffixSteps → canChunk false.
    expect(canChunk(steps)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

`composeScenarioYaml` already exists, so these should pass immediately (this task documents/guards existing behavior). Run:
Run: `npx vitest run tests/eval-chunking.test.ts`
Expected: PASS (all existing + new cases).

If `composeScenarioYaml` is NOT found on import, the daemon diff was not committed — stop and surface this; do not stub it.

- [ ] **Step 3: Commit**

```bash
git add tests/eval-chunking.test.ts
git commit -m "test: cover composeScenarioYaml + chunk-vs-compose decision

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 5: Reshape seed data

**Files:**
- Modify: `scripts/seed-data.ts:166-198`

- [ ] **Step 1: Replace the workflow + eval set seed block**

In `scripts/seed-data.ts`, replace the LiveKit workflow + eval set block (the `createWorkflow({...})` at line 167 and the `createEvalSet({...})` at line 186) with the following. This creates one shared eval set (body only), a LiveKit workflow (enter/exit only), and an Agora workflow (login + enter/exit), all aeval.

First locate the Agora provider alongside the existing `livekitProvider` lookup (near the top of this function there is already a providers fetch; add an Agora lookup next to it):

```ts
    const agoraProvider = providers.find(p => p.name.includes("Agora"));
```

Then the replacement block:

```ts
    // Shared eval-set body (provider-agnostic): a minimal aeval scenario with
    // analysis + steps, NO platform setup. inline YAML (not a filename).
    const sharedScenarioBody = `name: basic_conversation
description: Standard conversation latency body
analysis:
  preset: config/analysis_presets/default.yaml
params:
  output_dir: temp/output
steps:
  - type: audio.wait_for_speech
    timeout_ms: 30000
    silence_duration_ms: 1500
    description: Wait for agent greeting
  - type: control.for_each
    corpus_set: three_questions_en
    steps:
      - type: audio.play
        corpus_id: \${item}
        description: Play question (response latency test)
      - type: audio.wait_for_speech
        end_timeout_ms: 45000
        silence_duration_ms: 1000
        description: Wait for full agent response
`;

    // LiveKit workflow: platform enter/exit only (no login).
    const livekitWorkflow = await storage.createWorkflow({
      name: "LiveKit Agent Evaluation",
      description: "Mainline evaluation workflow for LiveKit Agents - runs every 8 hours",
      ownerId: scoutId,
      projectId: scoutProject.id,
      providerId: livekitProvider?.id || null,
      visibility: "public",
      isMainline: true,
      config: {
        framework: "aeval",
        stepsPrefix: `- type: platform.setup\n  platform_id: livekit\n  params:\n    mode: public\n- type: audio.start_recording\n- type: platform.enter\n  params:\n    tone_name: ''`,
        stepsSuffix: `- type: audio.stop_recording\n- type: platform.exit`,
      },
    });
    console.log(`Created LiveKit workflow: ${livekitWorkflow.name} (mainline: true)`);

    // Agora workflow: login/auth BEFORE enter — demonstrates provider-specific setup.
    const agoraWorkflow = await storage.createWorkflow({
      name: "Agora ConvoAI Evaluation",
      description: "Evaluation workflow for Agora ConvoAI - login required before joining",
      ownerId: scoutId,
      projectId: scoutProject.id,
      providerId: agoraProvider?.id || null,
      visibility: "public",
      isMainline: false,
      config: {
        framework: "aeval",
        stepsPrefix: `- type: platform.setup\n  platform_id: agora\n  params:\n    mode: authenticated\n- type: platform.login\n  params:\n    token: \${secrets.agora_token}\n- type: audio.start_recording\n- type: platform.enter\n  params:\n    tone_name: ''`,
        stepsSuffix: `- type: audio.stop_recording\n- type: platform.exit`,
      },
    });
    console.log(`Created Agora workflow: ${agoraWorkflow.name}`);

    // Shared eval set (body only) — referenced by both workflows.
    const scoutEvalSets = await storage.getEvalSetsByOwner(scoutId);
    let basicEvalSet = scoutEvalSets.find(e => e.name === "Basic Conversation Test");
    if (!basicEvalSet) {
      basicEvalSet = await storage.createEvalSet({
        name: "Basic Conversation Test",
        description: "Standard conversation evaluation for voice AI latency testing",
        ownerId: scoutId,
        visibility: "public",
        isMainline: true,
        config: {
          scenario: sharedScenarioBody,
        },
      });
      console.log(`Created eval set: ${basicEvalSet.name}`);
    }
```

Note: the schedule block below this (line ~200, `getEvalSchedulesByWorkflow(livekitWorkflow.id)`) still references `livekitWorkflow` — leave it unchanged.

- [ ] **Step 2: Reset and re-seed local dev**

```bash
./scripts/dev-local-run.sh reset
```

Expected: console shows "Created LiveKit workflow", "Created Agora workflow", "Created eval set: Basic Conversation Test" with no validation errors.

- [ ] **Step 3: Verify the split in the DB**

```bash
psql "postgresql://vox:vox123@localhost:5432/vox" \
  -c "SELECT name, config ? 'scenario' AS has_scenario, config ? 'stepsPrefix' AS has_prefix FROM workflows ORDER BY name;"
```

Expected: both workflows show `has_scenario = f` and `has_prefix = t`.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-data.ts
git commit -m "feat: reshape seed data for workflow/eval-set separation

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 6: Workflow editor — stepsPrefix / stepsSuffix

**Files:**
- Modify: `client/src/pages/console-workflows.tsx`

- [ ] **Step 1: Add state for the new fields**

Near the other `useState` declarations (around line 52 where `framework` is declared), add:

```tsx
  const [stepsPrefix, setStepsPrefix] = useState("");
  const [stepsSuffix, setStepsSuffix] = useState("");
  const [editStepsPrefix, setEditStepsPrefix] = useState("");
  const [editStepsSuffix, setEditStepsSuffix] = useState("");
```

- [ ] **Step 2: Include them in the create mutation**

In `createMutation.mutationFn` (line 84), after the `config.app` block, add:

```tsx
      if (framework === "aeval") {
        if (stepsPrefix) config.stepsPrefix = stepsPrefix;
        if (stepsSuffix) config.stepsSuffix = stepsSuffix;
      }
```

And in the `onSuccess` reset (line 97-108), add:

```tsx
      setStepsPrefix("");
      setStepsSuffix("");
```

- [ ] **Step 3: Include them in the edit mutation + open dialog**

In `editMutation.mutationFn` (line 122), after the `config.app` block, add:

```tsx
      if (editFramework === "aeval") {
        if (editStepsPrefix) config.stepsPrefix = editStepsPrefix;
        if (editStepsSuffix) config.stepsSuffix = editStepsSuffix;
      }
```

In `openEditDialog` (line 189), after `setEditAppConfigYaml(cfg.app || "");` add:

```tsx
    setEditStepsPrefix(cfg.stepsPrefix || "");
    setEditStepsSuffix(cfg.stepsSuffix || "");
```

- [ ] **Step 4: Add the textareas to both dialogs**

In the create dialog, after the framework `Select` block (the `framework === "voice-agent-tester"` app-config section, around line 288-320), add an aeval-only section:

```tsx
              {framework === "aeval" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Setup steps (stepsPrefix)</label>
                    <Textarea
                      value={stepsPrefix}
                      onChange={(e) => setStepsPrefix(e.target.value)}
                      placeholder={"- type: platform.setup\n  platform_id: livekit\n- type: platform.enter"}
                      className="font-mono text-xs"
                      rows={5}
                      data-testid="textarea-workflow-steps-prefix"
                    />
                    <p className="text-xs text-muted-foreground">
                      Platform connect/login steps. Differs per provider. The test body lives in the eval set.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Teardown steps (stepsSuffix)</label>
                    <Textarea
                      value={stepsSuffix}
                      onChange={(e) => setStepsSuffix(e.target.value)}
                      placeholder={"- type: audio.stop_recording\n- type: platform.exit"}
                      className="font-mono text-xs"
                      rows={3}
                      data-testid="textarea-workflow-steps-suffix"
                    />
                  </div>
                </div>
              )}
```

Add the equivalent block in the edit dialog (using `editFramework`, `editStepsPrefix`/`setEditStepsPrefix`, `editStepsSuffix`/`setEditStepsSuffix`, and `data-testid` suffixes `-edit`).

- [ ] **Step 5: Type-check and verify in the browser**

Run: `npm run check`
Expected: no errors.

Then manually (server running): open Console → Workflows → Create, select the aeval framework, confirm the two textareas appear; create a workflow with a `stepsPrefix`, reopen Edit, confirm the value round-trips. Attempting to save invalid (e.g. paste `scenario:` content is fine — it's free text; the server only rejects a `scenario` *config key*, which this UI never sets).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/console-workflows.tsx
git commit -m "feat: workflow editor supports aeval setup/teardown steps

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 7: Eval-set editor — body-only hint

**Files:**
- Modify: `client/src/pages/console-evalsets.tsx`

- [ ] **Step 1: Add a helper hint under the scenario textarea**

In `client/src/pages/console-evalsets.tsx`, find the create-dialog scenario `Textarea` (around line 309-314, `data-testid="textarea-evalset-scenario"`). Immediately after that `Textarea`, add:

```tsx
                <p className="text-xs text-muted-foreground">
                  Test body only (samples + analysis). Platform setup/login lives in the workflow.
                </p>
```

Add the same hint after the edit-dialog scenario `Textarea` (around line 578/601).

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/console-evalsets.tsx
git commit -m "feat: eval-set editor clarifies body-only scope

🤖 Built with SMT <smt@agora.build>"
```

---

## Task 8: Full verification

- [ ] **Step 1: Type-check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 2: Run the full unit/integration suite**

Ensure the local server is running, then:
Run: `npm test`
Expected: all tests pass, including the new `Config separation` (storage), `Config separation enforcement` (api), and `composeScenarioYaml` / `chunk-vs-compose` (eval-chunking) blocks.

- [ ] **Step 3: Confirm no stale references**

Run: `grep -rn "validateEvalConfig" server/ tests/`
Expected: no matches (the old function name is fully removed).

- [ ] **Step 4: Final commit (if anything outstanding)**

```bash
git status
# commit any remaining changes per the conventions above
```

---

## Self-Review Notes

- **Spec coverage:** §1 validators → Task 1; §2 merge → Task 1; §3 routes → Task 2; §4 migration → Task 3; §5 daemon → Task 4 (tests only, code pre-existing); §6 seed → Task 5; §7 UI → Tasks 6-7; §8 tests → Tasks 1, 2, 4 + final sweep Task 8.
- **Type consistency:** `validateWorkflowConfig` / `validateEvalSetConfig` / `mergeEvalConfig` used identically across storage, routes, and tests. `ScenarioStep` carries a `type` field (matches `extractSampleGroups` and real scenario YAML). `composeScenarioYaml(scenario, prefix, body, suffix)` signature matches the daemon's `chunking.ts`.
- **Migration:** version 11 / file `0010_strip_workflow_scenario.sql`, consistent with the existing array ending at version 10 (file 0009).
- **No schema.ts change** → no drizzle-generate; the migration is hand-written and registered, per project rules.
