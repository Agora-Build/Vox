-- Strip the eval-set-owned 'scenario' key from all workflow configs.
-- After the workflow/eval-set separation, the workflow owns only platform
-- setup/teardown + connection params; the test body (scenario) lives
-- exclusively in the eval set. The '-' operator removes a top-level jsonb key.
UPDATE workflows SET config = config - 'scenario' WHERE config ? 'scenario';
