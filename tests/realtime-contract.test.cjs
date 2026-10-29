const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const events = new Map();
const jobs = new Map();
let nextId = 0;
const state = { events, jobs };

function query(table) {
  const filters = [];
  let inserted;
  let updated;
  const api = {
    select() { return api; },
    eq(key, value) { filters.push([key, value]); return api; },
    insert(value) { inserted = value; return api; },
    update(value) { updated = value; return api; },
    async single() { return execute(true); },
    async maybeSingle() { return execute(true); },
    then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
  };
  function execute(one) {
    const rows = table === 'instagram_accounts'
      ? [{ id: 'account-1', organization_id: 'org-1', external_id: 'ig-1' }]
      : [...(table === 'webhook_events' ? events : jobs).values()];
    if (inserted) {
      const store = table === 'webhook_events' ? events : jobs;
      const key = table === 'webhook_events' ? inserted.idempotency_key : inserted.webhook_event_id + ':' + inserted.job_type;
      if (store.has(key)) return { data: null, error: { code: '23505' } };
      const row = { ...inserted, id: `id-${++nextId}`, attempts: 0, max_attempts: 3,
        available_at: new Date(0).toISOString(),
        ...(table === 'webhook_events' ? { received_at: new Date(0).toISOString() } : {}) };
      store.set(key, row);
      return { data: row, error: null };
    }
    const row = rows.find(item => filters.every(([key, value]) => item[key] === value));
    if (updated && row) Object.assign(row, updated);
    return { data: one ? row ?? null : null, error: null };
  }
  return api;
}

function loadHandler(name, env) {
  let handler;
  const source = fs.readFileSync(path.join(root, 'supabase/functions', name, 'index.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const client = {
    from: query,
    async rpc(name, args) {
      if (name === 'ingest_social_comment_event') {
        assert.ok([...events.values()].some(event => event.id === args.p_webhook_event_id));
        return { data: 'contact-test', error: null };
      }
      assert.equal(name, 'claim_processing_job');
      const job = [...jobs.values()].find(j => j.status === 'pending' && j.job_type === args.p_job_type);
      if (!job) return { data: [], error: null };
      Object.assign(job, { status: 'processing', locked_by: args.p_worker_id, attempts: job.attempts + 1, locked_at: new Date().toISOString() });
      return { data: [job], error: null };
    },
  };
  vm.runInNewContext(js, {
    require(spec) { if (spec.includes('supabase-js')) return { createClient: () => client }; return {}; },
    exports: {},
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    TextEncoder, Request, Response, URL, crypto: webcrypto, console,
  }, { filename: name });
  return handler;
}

function reset() { events.clear(); jobs.clear(); nextId = 0; }
function claim(handler, secret, worker = 'worker-a') {
  return handler(new Request('http://local', { method: 'POST', headers: secret ? { 'x-worker-secret': secret } : {}, body: JSON.stringify({ worker_id: worker }) }));
}
async function webhook(handler, commentId = 'comment-1') {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'ig-1', changes: [{
    field: 'comments', value: { id: commentId, text: 'Quero abrir uma franquia',
      from: { id: 'person-1', username: 'cliente.teste', name: 'Cliente Teste' },
      media: { id: 'media-1', media_product_type: 'FEED' } },
  }] }] });
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('meta-test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return handler(new Request('http://local', { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + Buffer.from(digest).toString('hex') }, body }));
}

test('claim fails closed and accepts the configured worker secret', async () => {
  reset();
  const handler = loadHandler('n8n-claim-instagram-job', { N8N_WORKER_SECRET: 'local-test-secret', SUPABASE_URL: 'http://local', SUPABASE_SERVICE_ROLE_KEY: 'local-key' });
  assert.equal((await claim(handler)).status, 401);
  assert.equal((await claim(handler, 'wrong')).status, 401);
  const valid = await claim(handler, 'local-test-secret');
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).job, null);
  const unconfigured = loadHandler('n8n-claim-instagram-job', {});
  assert.equal((await claim(unconfigured, 'anything')).status, 503);
});

test('signed realtime webhook queues once and two workers cannot claim the same job', async () => {
  reset();
  const ingress = loadHandler('meta-instagram-webhook', { META_APP_SECRET: 'meta-test', SUPABASE_URL: 'http://local', SUPABASE_SERVICE_ROLE_KEY: 'local-key' });
  assert.equal((await webhook(ingress)).status, 200);
  assert.equal((await webhook(ingress)).status, 200);
  assert.equal(events.size, 1);
  assert.equal(jobs.size, 1);
  const event = [...events.values()][0];
  assert.equal(event.idempotency_key, 'meta:instagram:comments:ig-1:comment-1');
  assert.equal(event.status, 'queued');
  assert.equal([...jobs.values()][0].status, 'pending');
  const claimHandler = loadHandler('n8n-claim-instagram-job', { N8N_WORKER_SECRET: 'local-test-secret', SUPABASE_URL: 'http://local', SUPABASE_SERVICE_ROLE_KEY: 'local-key' });
  const first = await (await claim(claimHandler, 'local-test-secret', 'worker-a')).json();
  const second = await (await claim(claimHandler, 'local-test-secret', 'worker-b')).json();
  assert.equal(first.job.locked_by, 'worker-a');
  assert.deepEqual(first.engagement, {
    organization_id: 'org-1',
    instagram_account_id: 'account-1',
    external_user_id: 'person-1',
    username: 'cliente.teste',
    display_name: 'Cliente Teste',
    engagement_type: 'comment',
    external_engagement_id: 'comment-1',
    webhook_event_id: event.id,
    text: 'Quero abrir uma franquia',
    source: 'realtime',
    occurred_at: event.received_at,
    media_external_id: 'media-1',
    metadata: { media_product_type: 'FEED' },
  });
  assert.equal(second.job, null);
});

test('historical import keeps the same identity and atomic insert contract', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/panel-import-instagram-comments/index.ts'), 'utf8');
  const claim = fs.readFileSync(path.join(root, 'supabase/functions/n8n-claim-instagram-job/index.ts'), 'utf8');
  const rpc = fs.readFileSync(path.join(root, 'supabase/migrations/20260827191000_add_atomic_historical_comment_import.sql'), 'utf8');
  assert.match(source, /source: "historical_backfill"/);
  assert.match(source, /`meta:instagram:comments:`/);
  assert.match(source, /panel_import_historical_instagram_comment/);
  assert.match(rpc, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(rpc, /'already_exists'::text/);
  assert.match(rpc, /'pending'/);
  assert.match(claim, /payload\?\.source === "historical_backfill"/);
  assert.match(claim, /source,\s*\n\s*occurred_at: occurredAt/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'supabase/functions/meta-instagram-webhook/index.ts'), 'utf8'), /historical_backfill|panel_import_historical_instagram_comment/);
});
