const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Instagram dispatch is fail-safe and blocks before claiming an action', () => {
  const source = fs.readFileSync(
    path.join(root, 'supabase/functions/n8n-dispatch-instagram-action/index.ts'),
    'utf8',
  );
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

  assert.match(source, /Deno\.env\.get\("INSTAGRAM_DISPATCH_DRY_RUN"\) \?\? "true"/);
  assert.match(source, /configured !== "false"/);
  assert.match(source, /error: "dispatch_dry_run_enabled"/);
  assert.match(source, /status: 423/);
  assert.ok(
    source.indexOf('if (dispatchDryRunEnabled())') <
      source.indexOf('claim_outbound_action_for_dispatch'),
    'dry-run guard must execute before the database claim',
  );
  assert.match(example, /^INSTAGRAM_DISPATCH_DRY_RUN=true$/m);
});
