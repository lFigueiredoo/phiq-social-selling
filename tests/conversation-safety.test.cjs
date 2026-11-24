const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('conversation schema requires inbound consent window, approval, limits and opt-out', () => {
  const core = read('supabase/migrations/20261124220000_add_social_inbox_and_commercial_operations.sql');
  const privacy = read('supabase/migrations/20261124221000_add_social_inbox_read_privacy_and_monitoring_rpcs.sql');
  assert.match(core, /v_occurred \+ interval '24 hours'/i);
  assert.match(core, /direction='outbound' and m[.]status='approved'/i);
  assert.match(core, /v_conversation_count>=5/i);
  assert.match(core, /p_account_daily_limit/i);
  assert.match(core, /v_conversation[.]opted_out or v_conversation[.]status='blocked'/i);
  assert.match(core, /unapproved_catalog_url/i);
  assert.match(core, /conversation_message[.]approved/i);
  assert.match(core, /retention_enabled boolean not null default false/i);
  assert.match(privacy, /social_suppression_identities/i);
  assert.match(privacy, /\[conteúdo anonimizado\]/i);
  assert.match(privacy, /run_social_retention/i);
});

test('conversation dispatcher is fail-safe and reconciliation stays database-backed', () => {
  const dispatch = read('supabase/functions/n8n-dispatch-conversation-message/index.ts');
  assert.match(dispatch, /INSTAGRAM_CONVERSATION_DISPATCH_ENABLED/);
  assert.match(dispatch, /INSTAGRAM_DISPATCH_DRY_RUN/);
  assert.match(dispatch, /claim_instagram_conversation_message/);
  assert.match(dispatch, /mark_instagram_conversation_message_sent/);
  assert.match(dispatch, /mark_instagram_conversation_message_error/);
  assert.match(dispatch, /AbortSignal[.]timeout\(15_000\)/);
  assert.doesNotMatch(dispatch, /status\s*:\s*["']approved["'][\s\S]*fetch\(/i);
});

test('versioned conversation and maintenance workflows use only the central credential', () => {
  for (const file of ['ig-social-selling-conversation-dispatch.json', 'ig-social-selling-maintenance.json']) {
    const raw = read(`n8n/workflows/${file}`);
    const workflow = JSON.parse(raw);
    const http = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest');
    assert.equal(workflow.active, true);
    assert.ok(http.length >= 2);
    assert.ok(http.every(node => node.parameters.authentication === 'genericCredentialType' &&
      node.credentials?.httpHeaderAuth?.name === 'PHIQ Supabase Worker'));
    assert.doesNotMatch(raw, /x-worker-secret/i);
    assert.doesNotMatch(raw, /(?:sk-|re_)[A-Za-z0-9_-]{20,}/);
  }
});

test('panel exposes conversations, human approval, operations and privacy controls', () => {
  const routes = read('panel-web/src/router.tsx');
  const nav = read('panel-web/src/components/layout/AppShell.tsx');
  const conversations = read('panel-web/src/pages/ConversationsPage.tsx');
  const operations = read('panel-web/src/pages/SocialOperationsPage.tsx');
  assert.match(routes, /path="\/conversas"/);
  assert.match(routes, /path="\/operacao"[\s\S]*AdminOnly/);
  assert.match(nav, /Conversas/);
  assert.match(nav, /Operação/);
  assert.match(conversations, /Aprovar envio/);
  assert.match(conversations, /Registrar opt-out/);
  assert.match(conversations, /Criar uma resposta não envia nada/);
  assert.match(operations, /Catálogo comercial aprovado/);
  assert.match(operations, /Privacidade e LGPD/);
  assert.match(operations, /Aceitação do Gemini/);
});

