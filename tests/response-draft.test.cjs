const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');

const root = path.join(__dirname, '..');

function load(relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require() { return {}; }, JSON, Error, Set, Number, TextEncoder }, { filename: relative });
  return exports;
}

const drafts = load('supabase/functions/_shared/responseDraft.ts');

test('backend builds a bounded public-reply prompt from untrusted context', () => {
  const request = drafts.buildResponseDraftRequest({
    commentText: 'x'.repeat(2500),
    source: 'historical_backfill',
    eventType: 'comments',
    classification: {
      intent: 'franchise_interest', commercial_potential: 'high', lead_score: 80,
      route_type: 'franchise', confidence: 0.95, reason: 'Explicit interest.',
      signals: Array.from({ length: 15 }, (_, index) => `signal-${index}`),
      needs_more_signal: false,
    },
  });

  assert.equal(request.prompt_version, drafts.RESPONSE_DRAFT_PROMPT_VERSION);
  assert.equal(request.model, 'models/gemini-3.6-flash');
  assert.match(request.system_prompt, /untrusted customer data/i);
  assert.match(request.system_prompt, /mandatory human approval/i);
  assert.match(request.system_prompt, /public-reply draft/i);
  const context = JSON.parse(request.context_json);
  assert.equal(context.comment_text.length, 2000);
  assert.equal(context.source, 'historical_backfill');
  assert.equal(context.target_channel, 'public_reply');
  assert.equal(context.classification.signals.length, 12);
});

test('backend selects private reply only for strong realtime commercial intent', () => {
  const privateRequest = drafts.buildResponseDraftRequest({
    commentText: 'Quero conhecer o curso e saber como comprar.',
    source: 'realtime',
    eventType: 'comments',
    classification: {
      intent: 'course_interest', commercial_potential: 'high', lead_score: 82,
      needs_more_signal: false, route_type: 'course', confidence: 0.95,
    },
  });
  assert.equal(privateRequest.target_channel, 'private_reply');
  assert.match(privateRequest.system_prompt, /only private reply allowed/i);
  assert.match(privateRequest.system_prompt, /ask permission/i);
  assert.equal(JSON.parse(privateRequest.context_json).target_channel, 'private_reply');

  const weakRequest = drafts.buildResponseDraftRequest({
    commentText: 'Legal!', source: 'realtime', eventType: 'comments',
    classification: {
      intent: 'engagement', commercial_potential: 'low', lead_score: 20,
      needs_more_signal: true,
    },
  });
  assert.equal(weakRequest.target_channel, 'public_reply');

  const historicalRequest = drafts.buildResponseDraftRequest({
    commentText: 'Quero comprar.', source: 'historical_backfill', eventType: 'comments',
    classification: {
      intent: 'product_interest', commercial_potential: 'high', lead_score: 90,
      needs_more_signal: false,
    },
  });
  assert.equal(historicalRequest.target_channel, 'public_reply');
});

test('draft validator accepts the strict contract and normalizes whitespace', () => {
  const result = drafts.validateResponseDraftOutput({
    message_text: '  Obrigado pelo interesse!   Nossa equipe pode orientar os próximos passos.  ',
    sentiment: 'positive',
    analysis_summary: '  Resposta cordial sem inventar informações.  ',
  });
  assert.equal(result.message_text,
    'Obrigado pelo interesse! Nossa equipe pode orientar os próximos passos.');
  assert.equal(result.analysis_summary, 'Resposta cordial sem inventar informações.');
});

test('draft validator rejects extra fields, links and oversized text', () => {
  const base = {
    message_text: 'Obrigado pelo interesse!',
    sentiment: 'neutral',
    analysis_summary: 'Resposta segura.',
  };
  assert.throws(() => drafts.validateResponseDraftOutput({ ...base, action: 'send' }),
    /invalid_draft_schema/);
  assert.throws(() => drafts.validateResponseDraftOutput({ ...base, message_text: 'Veja https://example.com' }),
    /unsafe_draft_content/);
  assert.throws(() => drafts.validateResponseDraftOutput({ ...base, message_text: 'x'.repeat(501) }),
    /invalid_draft_schema/);
  assert.throws(() => drafts.validateResponseDraftOutput({ ...base, message_text: '💡'.repeat(300) }),
    /invalid_draft_schema/);
});

test('database draft persistence keeps both channels proposed and private replies tightly gated', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations',
    '20261124183000_enable_safe_private_reply_pilot.sql'), 'utf8');
  const hardening = fs.readFileSync(path.join(root, 'supabase/migrations',
    '20261124203000_harden_private_reply_content_and_rate_limit.sql'), 'utf8');
  assert.match(sql, /status = 'processing'[\s\S]*locked_by = p_worker_id/i);
  assert.match(sql, /v_score >= 70/i);
  assert.match(sql, /needs_more_signal'[\s\S]*= 'false'/i);
  assert.match(sql, /v_source = 'realtime'[\s\S]*v_event[.]event_type = 'comments'/i);
  assert.match(sql, /'private_reply'[\s\S]*'proposed'[\s\S]*'not_checked'/i);
  assert.match(sql, /historical_backfill/i);
  assert.match(sql, /Meta policy and human approval remain mandatory/i);
  assert.match(sql, /octet_length[\s\S]*1000/i);
  assert.match(sql, /interval '24 hours'/i);
  assert.doesNotMatch(sql, /dispatch_instagram|graph\.instagram/i);
  assert.match(sql, /p_private_reply_daily_limit integer default 5/i);
  assert.match(hardening, /enforce_private_reply_pilot_content/i);
  assert.match(hardening, /length\(btrim\(new[.]message_text\)\) > 500/i);
  assert.match(hardening, /https\?[:][\\/]\{2\}|www/i);
  assert.match(hardening, /outbound_action[.]requeued_daily_limit/i);
  assert.match(hardening, /set status = 'proposed'[^;]*approved_at = null[^;]*approved_by = null/is);
});

test('draft endpoints are worker-only and never call the Instagram API', () => {
  const prepare = fs.readFileSync(path.join(root, 'supabase/functions/n8n-prepare-instagram-draft/index.ts'), 'utf8');
  const save = fs.readFileSync(path.join(root, 'supabase/functions/n8n-save-instagram-draft/index.ts'), 'utf8');
  for (const source of [prepare, save]) {
    assert.match(source, /N8N_WORKER_SECRET/);
    assert.match(source, /x-worker-secret/);
    assert.doesNotMatch(source, /graph\.instagram|META_ACCESS_TOKEN|dispatch/i);
  }
  assert.match(prepare, /draft_already_exists/);
  assert.match(prepare, /draft_policy_reconciled/);
  assert.match(save, /validateResponseDraftOutput/);
  assert.match(save, /save_instagram_response_draft/);
  assert.match(save, /checkOutboundPolicy/);
});
