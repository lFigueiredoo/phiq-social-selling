const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');

function compile(relative) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const classifier = {};
vm.runInNewContext(compile('supabase/functions/_shared/socialClassifier.ts'),
  { exports: classifier, require() { return {}; }, JSON, console, Error },
  { filename: 'socialClassifier.ts' });

function endpoint(providerError) {
  const calls = [];
  const env = {
    N8N_WORKER_SECRET: 'local-test-secret', SUPABASE_URL: 'http://local',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key', OPENAI_API_KEY: 'test-ai-key', SOCIAL_CLASSIFIER_MODEL: 'test-model',
  };
  let handler;
  const prepared = {
    organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    contact_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    engagement_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    lead_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    central_stage: 'new_lead', route_type: null, result_code: 'classification_pending',
    context_snapshot: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', engagement_type: 'comment',
      source: 'realtime', occurred_at: '2026-09-27T00:00:00Z', metadata: { text: 'Preciso de ajuda com a operação da empresa' } }],
    actions_performed: ['contact_upserted', 'engagement_recorded', 'lead_created'],
  };
  const db = { rpc(name, args) {
    calls.push({ name, args });
    if (name === 'prepare_social_engagement_pipeline') return Promise.resolve({ data: prepared, error: null });
    if (name === 'mark_social_engagement_pipeline_failure') return Promise.resolve({
      data: { ...prepared, result_code: 'retryable_error', classification_status: 'failed_retryable',
        error_code: args.p_error_code, retryable: true }, error: null,
    });
    throw new Error(`unexpected RPC: ${name}`);
  } };
  vm.runInNewContext(compile('supabase/functions/process-social-engagement/index.ts'), {
    exports: {}, Request, Response, JSON, console, Date, Error,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    require(spec) {
      if (spec.includes('supabase-js')) return { createClient() { return db; } };
      if (spec.includes('socialClassifier.ts')) return classifier;
      if (spec.includes('openaiSocialClassifier.ts')) return {
        createOpenAIClassifier() { return async () => { throw providerError; }; },
      };
      return {};
    },
  }, { filename: 'process-social-engagement/index.ts' });
  const request = (secret = 'local-test-secret') => handler(new Request('http://local', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': secret },
    body: JSON.stringify({ organization_id: prepared.organization_id,
      instagram_account_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      external_user_id: 'test-user', engagement_type: 'comment', source: 'realtime',
      external_engagement_id: 'test-1', text: 'Preciso de ajuda com a operação da empresa' }),
  }));
  return { request, calls, env };
}

test('orchestrator rejects unauthenticated calls before touching the database', async () => {
  const { request, calls } = endpoint(new Error('unreachable'));
  assert.equal((await request('wrong')).status, 401);
  assert.equal(calls.length, 0);
});

test('provider failures retain phase A data and return a retryable code', async () => {
  const failures = [
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'classifier_timeout'],
    [new Error('classifier_rate_limited'), 'classifier_rate_limited'],
    [new Error('classifier_provider_error'), 'classifier_provider_error'],
    [new Error('invalid_ai_schema'), 'classifier_invalid_output'],
  ];
  for (const [error, code] of failures) {
    const { request, calls } = endpoint(error);
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result_code, 'retryable_error');
    assert.equal(body.error_code, code);
    assert.equal(body.retryable, true);
    assert.deepEqual(calls.map(item => item.name), [
      'prepare_social_engagement_pipeline', 'mark_social_engagement_pipeline_failure',
    ]);
    assert.equal(calls[1].args.p_error_code, code);
  }
});

test('missing classifier model remains retryable without applying a route', async () => {
  const { request, calls, env } = endpoint(new Error('unreachable'));
  delete env.SOCIAL_CLASSIFIER_MODEL;
  const body = await (await request()).json();
  assert.equal(body.result_code, 'retryable_error');
  assert.equal(body.error_code, 'classifier_unavailable');
  assert.equal(calls.at(-1).name, 'mark_social_engagement_pipeline_failure');
});
