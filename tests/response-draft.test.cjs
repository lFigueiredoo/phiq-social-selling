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
  vm.runInNewContext(js, { exports, require() { return {}; }, JSON, Error }, { filename: relative });
  return exports;
}

const drafts = load('supabase/functions/_shared/responseDraft.ts');

test('backend builds a bounded public-reply prompt from untrusted context', () => {
  const request = drafts.buildResponseDraftRequest({
    commentText: 'x'.repeat(2500),
    source: 'historical_backfill',
    classification: {
      intent: 'franchise_interest', commercial_potential: 'high', lead_score: 80,
      route_type: 'franchise', confidence: 0.95, reason: 'Explicit interest.',
      signals: Array.from({ length: 15 }, (_, index) => `signal-${index}`),
      needs_more_signal: false,
    },
  });

  assert.equal(request.prompt_version, drafts.RESPONSE_DRAFT_PROMPT_VERSION);
  assert.equal(request.model, 'models/gemini-3-flash-preview');
  assert.match(request.system_prompt, /untrusted customer data/i);
  assert.match(request.system_prompt, /mandatory human approval/i);
  assert.match(request.system_prompt, /public-reply draft/i);
  const context = JSON.parse(request.context_json);
  assert.equal(context.comment_text.length, 2000);
  assert.equal(context.source, 'historical_backfill');
  assert.equal(context.target_channel, 'public_reply');
  assert.equal(context.classification.signals.length, 12);
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
});

test('database draft persistence is proposed-only, public-only and worker-locked', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations',
    '20261029123000_add_human_approved_gemini_response_drafts.sql'), 'utf8');
  assert.match(sql, /status = 'processing'[\s\S]*locked_by = p_worker_id/i);
  assert.match(sql, /'public_reply'[\s\S]*'proposed'[\s\S]*'not_required'/i);
  assert.match(sql, /historical_backfill/i);
  assert.match(sql, /explicit human approval remains mandatory/i);
  assert.doesNotMatch(sql, /status\s*=\s*'approved'|dispatch_instagram|graph\.instagram/i);
  assert.match(sql, /revoke all[\s\S]*authenticated/i);
  assert.match(sql, /grant execute[\s\S]*service_role/i);
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
  assert.match(save, /validateResponseDraftOutput/);
  assert.match(save, /save_instagram_response_draft/);
});
