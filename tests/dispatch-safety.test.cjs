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
  const queue = fs.readFileSync(
    path.join(root, 'supabase/functions/n8n-get-next-instagram-action/index.ts'),
    'utf8',
  );

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
  assert.match(source, /Deno\.env\.get\("INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY"\) \?\? "true"/);
  assert.match(source, /error: "dispatch_action_type_not_enabled"/);
  assert.ok(
    source.indexOf('if (publicReplyOnlyEnabled())') <
      source.indexOf('claim_outbound_action_for_dispatch'),
    'public-reply-only guard must execute before the database claim',
  );
  assert.match(queue, /Deno\.env\.get\("INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY"\) \?\? "true"/);
  assert.match(queue, /query = query\.eq\("action_type", "public_reply"\)/);
  assert.match(example, /^INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=true$/m);
});

test('panel exposes dispatch mode and requires an explicit automatic-dispatch acknowledgement', () => {
  const panelMe = fs.readFileSync(path.join(root,
    'supabase/functions/panel-me/index.ts'), 'utf8');
  const approve = fs.readFileSync(path.join(root,
    'supabase/functions/panel-approve-action/index.ts'), 'utf8');
  const client = fs.readFileSync(path.join(root,
    'panel-web/src/lib/api/panelApproveAction.ts'), 'utf8');
  const card = fs.readFileSync(path.join(root,
    'panel-web/src/components/queue/ActionCard.tsx'), 'utf8');
  const queue = fs.readFileSync(path.join(root,
    'panel-web/src/pages/QueuePage.tsx'), 'utf8');

  assert.match(panelMe, /INSTAGRAM_DISPATCH_DRY_RUN/);
  assert.match(panelMe, /automatic_dispatch_enabled/);
  assert.match(panelMe, /public_reply_only/);
  assert.match(panelMe, /allowed_action_types/);
  assert.match(approve, /acknowledge_automatic_dispatch[\s\S]*dispatch_acknowledgement_required/);
  assert.match(client, /acknowledge_automatic_dispatch: true/);
  assert.match(card, /Confirmar aprovação/);
  assert.match(card, /disabled=\{isBusy \|\| hasMessageChanged\}/);
  assert.match(card, /Aprovar e liberar envio/);
  assert.match(queue, /Envio automático ativo/);
  assert.match(queue, /Piloto ativo: respostas públicas/);
  assert.match(queue, /Direct permanece bloqueado/);
  assert.match(queue, /Modo seguro: envio bloqueado/);
});
