const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflowPath = path.join(root, 'n8n', 'workflows', 'ig-social-selling-orchestrator.json');

test('versioned n8n worker is importable, secret-free and fail-safe', () => {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const workflow = JSON.parse(raw);
  const names = new Set(workflow.nodes.map(node => node.name));
  assert.deepEqual([...names], [
    'Poll queue', 'Claim next job', 'Gate claimed job', 'Process engagement',
    'Normalize outcome', 'Finalize job',
  ]);
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.match(raw, /\$env\.N8N_WORKER_SECRET/);
  assert.match(raw, /\$env\.SUPABASE_FUNCTIONS_URL/);
  assert.match(raw, /n8n-claim-instagram-job/);
  assert.match(raw, /process-social-engagement/);
  assert.match(raw, /n8n-update-instagram-job/);
  assert.match(raw, /dead_letter/);
  assert.match(raw, /retry_after_seconds/);
  assert.doesNotMatch(raw, /(?:sk-|re_)[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(raw, /SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY/);
});

test('terminal job handling is atomic and restricted to service role', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations',
    '20261028234500_add_terminal_processing_job_dead_letter.sql'), 'utf8');
  const endpoint = fs.readFileSync(path.join(root, 'supabase', 'functions',
    'n8n-update-instagram-job', 'index.ts'), 'utf8');
  assert.match(migration, /where id = p_job_id[\s\S]*status = 'processing'[\s\S]*locked_by = p_worker_id/i);
  assert.match(migration, /set status = 'dead_letter'/i);
  assert.match(migration, /revoke all[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*service_role/i);
  assert.match(endpoint, /dead_letter_processing_job/);
  assert.match(endpoint, /\["complete", "fail", "dead_letter"\]/);
});
