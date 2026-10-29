const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');

function load(relative, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: spec => mocks[spec], JSON, console }, { filename: relative });
  return exports;
}

const classifier = load('supabase/functions/_shared/socialClassifier.ts');
const ctx = (currentText, mediaContext = '', extra = {}) => ({
  currentText, mediaContext, recentInteractions: [], source: 'realtime', engagementCount: 1, ...extra,
});

test('explicit commercial requests classify without calling AI', async () => {
  const examples = [
    ['quero abrir uma franquia', '', 'franchise'],
    ['quanto custa para abrir uma unidade?', 'post sobre franquia', 'franchise'],
    ['vocês fazem diagnóstico na indústria?', '', 'q3'],
    ['qual o preço do curso?', 'post sobre curso', 'hotmart'],
    ['onde compro esse aromatizador?', 'post NUY', 'nuy'],
  ];
  let calls = 0;
  for (const [text, media, route] of examples) {
    const result = await classifier.classifySocialLeadContext(ctx(text, media), async () => { calls++; throw Error('unexpected AI'); });
    assert.equal(result.classifierSource, 'deterministic');
    assert.equal(result.classification.route_type, route);
    assert.ok(result.classification.confidence >= 0.85);
    assert.ok(result.classification.lead_score >= 35);
  }
  assert.equal(calls, 0);
});

test('generic engagement and ambiguous interest do not force a vertical route', async () => {
  for (const text of ['parabéns 👏', '👏']) {
    const result = await classifier.classifySocialLeadContext(ctx(text));
    assert.equal(result.classification.route_type, 'no_profile');
    assert.ok(result.classification.confidence < 0.6);
  }
  const ambiguous = await classifier.classifySocialLeadContext(ctx('quero saber mais'));
  assert.equal(ambiguous.classification.route_type, 'no_profile');
  assert.equal(ambiguous.classification.needs_more_signal, true);
  assert.ok(ambiguous.classification.confidence >= 0.6 && ambiguous.classification.confidence < 0.85);
  const like = await classifier.classifySocialLeadContext(ctx('', '', { source: 'browser_collector' }));
  assert.equal(like.classification.route_type, 'no_profile');
  assert.equal(like.classification.lead_score, 0);
});

test('AI adapter is only used for unresolved context and malformed output fails closed', async () => {
  const input = ctx('preciso de ajuda com a operação da empresa');
  let calls = 0;
  const invalid = await classifier.classifySocialLeadContext(input, async () => { calls++; return '{bad'; });
  assert.equal(calls, 1);
  assert.equal(invalid.classifierSource, 'fallback');
  assert.equal(invalid.classification.route_type, 'no_profile');
  assert.equal(invalid.classification.needs_more_signal, true);
  const valid = {
    intent: 'q3_interest', commercial_potential: 'high', lead_score: 90, route_type: 'q3',
    confidence: 0.93, reason: 'Business process need stated.', recommended_next_action: 'human_review',
    signals: ['business operation'], needs_more_signal: false,
  };
  for (const patch of [{ route_type: 'invalid' }, { lead_score: 101 }, { confidence: 1.1 }, { recommended_next_action: 'send_dm' }]) {
    const result = await classifier.classifySocialLeadContext(input, async () => ({ ...valid, ...patch }));
    assert.equal(result.classifierSource, 'fallback');
  }
  const parsed = await classifier.classifySocialLeadContext(input, async () => valid);
  assert.equal(parsed.classifierSource, 'ai');
  assert.ok(parsed.classification.confidence < 0.85); // No matching evidence in current text.
  assert.notEqual(parsed.classification.lead_score, 90); // Deterministic score wins.
  const grounded = await classifier.classifySocialLeadContext(
    ctx('preciso melhorar a operação da empresa', 'post sobre Q3 e qualidade'), async () => valid);
  assert.ok(grounded.classification.confidence >= 0.85);
});

test('new explicit signal overrides old weak history', async () => {
  const result = await classifier.classifySocialLeadContext(ctx('quero abrir uma franquia', 'post NUY', {
    recentInteractions: [{ text: '👏', occurredAt: '2026-07-01', type: 'comment', source: 'historical_backfill' }],
    engagementCount: 2,
  }));
  assert.equal(result.classification.route_type, 'franchise');
  assert.equal(result.classifierSource, 'deterministic');
});

test('Gemini request is built by the backend with bounded untrusted context', () => {
  const request = classifier.buildClassifierRequest(ctx('preciso melhorar a operação', 'post Q3', {
    recentInteractions: [{ text: 'x'.repeat(800), occurredAt: '2026-10-28', type: 'comment', source: 'realtime' }],
  }));
  assert.equal(request.prompt_version, classifier.CLASSIFIER_PROMPT_VERSION);
  assert.match(request.system_prompt, /untrusted data/i);
  const payload = JSON.parse(request.context_json);
  assert.equal(payload.current_text, 'preciso melhorar a operação');
  assert.equal(payload.media_context, 'post Q3');
  assert.equal(payload.recent_interactions[0].text.length, 500);
});

test('classifier endpoint fails closed before any database or provider access', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/classify-social-lead/index.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let handler;
  let dbCalls = 0;
  const env = { N8N_WORKER_SECRET: 'local-only-secret', SUPABASE_URL: 'http://local' };
  vm.runInNewContext(js, {
    exports: {}, Request, Response, URL, console,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    require(spec) {
      if (spec.includes('supabase-js')) return { createClient() { dbCalls++; throw Error('unexpected DB'); } };
      if (spec.includes('socialClassifier.ts')) return classifier;
      return {};
    },
  });
  const request = (secret, body = '{}') => handler(new Request('http://local', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-worker-secret': secret } : {}) }, body,
  }));
  assert.equal((await request('')).status, 401);
  assert.equal((await request('wrong')).status, 401);
  assert.equal((await request('local-only-secret')).status, 400);
  delete env.N8N_WORKER_SECRET;
  assert.equal((await request('local-only-secret')).status, 503);
  assert.equal(dbCalls, 0);
});
