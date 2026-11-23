const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');

const root = path.resolve(__dirname, '..');

function loadMeta(env) {
  const source = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/meta.ts'),
    'utf8',
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exported = {};
  vm.runInNewContext(js, {
    exports: exported,
    Deno: { env: { get: key => env[key] } },
    URLSearchParams,
    Error,
  }, { filename: 'meta.ts' });
  return exported;
}

function supabaseWith({ account = null, identifier = null, identifierError = null } = {}) {
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        async maybeSingle() {
          if (table === 'instagram_accounts') {
            return { data: account, error: null };
          }
          assert.equal(table, 'instagram_account_identifiers');
          if (identifierError) return { data: null, error: identifierError };
          const matches = identifier && filters.every(([key, value]) => identifier[key] === value);
          return { data: matches ? identifier : null, error: null };
        },
      };
      return query;
    },
  };
}

test('Meta provider defaults to the current Instagram Login integration', () => {
  const meta = loadMeta({ META_ACCESS_TOKEN: 'legacy-secret', META_API_VERSION: 'v26.0' });
  const runtime = meta.getMetaRuntime();
  assert.equal(runtime.authMode, 'instagram_login');
  assert.equal(runtime.graphBaseUrl, 'https://graph.instagram.com');
  assert.equal(runtime.apiVersion, 'v26.0');
  assert.equal(
    meta.metaUrl(runtime, '123/media', new URLSearchParams({ limit: '25' })),
    'https://graph.instagram.com/v26.0/123/media?limit=25',
  );
});

test('Unified Login uses a separate token, Facebook Graph host and required ID alias', async () => {
  const meta = loadMeta({
    META_AUTH_MODE: 'unified_login',
    META_ACCESS_TOKEN: 'must-not-be-used',
    META_UNIFIED_ACCESS_TOKEN: 'unified-secret',
    META_UNIFIED_API_VERSION: 'v26.0',
  });
  const runtime = meta.getMetaRuntime();
  assert.equal(runtime.accessToken, 'unified-secret');
  assert.equal(runtime.graphBaseUrl, 'https://graph.facebook.com');

  const identifier = {
    instagram_account_id: 'account-1',
    organization_id: 'org-1',
    auth_mode: 'unified_login',
    identifier_type: 'api_user_id',
    external_id: 'unified-user-1',
    status: 'active',
    is_primary: true,
  };
  const id = await meta.resolveMetaApiUserId(
    supabaseWith({ identifier }),
    runtime,
    { id: 'account-1', organization_id: 'org-1', external_id: 'legacy-user-1' },
  );
  assert.equal(id, 'unified-user-1');
});

test('Unified Login fails closed when its token or API user alias is absent', async () => {
  const missingToken = loadMeta({ META_AUTH_MODE: 'unified_login' });
  assert.throws(
    () => missingToken.getMetaRuntime(),
    err => err.code === 'meta_unified_access_token_missing',
  );

  const meta = loadMeta({
    META_AUTH_MODE: 'unified_login',
    META_UNIFIED_ACCESS_TOKEN: 'unified-secret',
  });
  const runtime = meta.getMetaRuntime();
  await assert.rejects(
    meta.resolveMetaApiUserId(
      supabaseWith(),
      runtime,
      { id: 'account-1', organization_id: 'org-1', external_id: 'legacy-user-1' },
    ),
    err => err.code === 'meta_unified_api_user_id_missing',
  );
});
