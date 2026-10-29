// Runs the Edge handler against the local Supabase API without starting Edge runtime.
// Uses deterministic classification only and removes all fixtures.
const { randomUUID } = require('node:crypto');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../panel-web/node_modules/typescript');
const { createClient } = require('../../panel-web/node_modules/@supabase/supabase-js');

const root = path.join(__dirname, '..', '..');
const org = randomUUID();
const account = randomUUID();
const dbArgs = ['exec', '-i', 'supabase_db_social-selling-ig', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'postgres', '-At'];
function sql(query) {
  return execFileSync('docker', dbArgs, { input: query, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
}
function moduleFrom(relative, mocks = {}) {
  const code = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  let handler;
  vm.runInNewContext(js, {
    exports, Request, Response, fetch, AbortSignal, JSON, Date, console,
    Deno: { env: { get: key => mocks.env?.[key] }, serve: fn => { handler = fn; } },
    require: spec => mocks.require?.(spec) ?? {},
  }, { filename: relative });
  return { exports, handler };
}

(async () => {
  try {
    const raw = execSync('npx supabase status --output json', { cwd: root, encoding: 'utf8' });
    const local = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const classifier = moduleFrom('supabase/functions/_shared/socialClassifier.ts').exports;
    const env = { N8N_WORKER_SECRET: 'local-http-test-only', SUPABASE_URL: local.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY };
    const { handler } = moduleFrom('supabase/functions/process-social-engagement/index.ts', {
      env, require: spec => {
        if (spec.includes('supabase-js')) return { createClient };
        if (spec.includes('socialClassifier.ts')) return classifier;
        return {};
      },
    });
    sql(`insert into public.organizations(id,name) values('${org}','f22f-http-local');
      insert into public.instagram_accounts(id,organization_id,external_id,status)
        values('${account}','${org}','f22f-http-local','active');`);
    const send = async (identity) => {
      const response = await handler(new Request('http://local/functions/v1/process-social-engagement', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': env.N8N_WORKER_SECRET },
        body: JSON.stringify({ organization_id: org, instagram_account_id: account,
          external_user_id: 'f22f-http-person', engagement_type: 'comment', source: 'realtime',
          external_engagement_id: identity, text: 'Quero abrir uma franquia, como funciona?' }),
      }));
      const body = await response.json();
      if (response.status !== 200) throw new Error(`endpoint failed: ${JSON.stringify(body)}`);
      return body;
    };
    const first = await send('http-first');
    const second = await send('http-second');
    const replay = await send('http-second');
    const outbound = Number(sql(`select count(*) from public.outbound_actions where organization_id='${org}';`));
    if (first.result_code !== 'classified' || second.result_code !== 'routed' ||
      second.route_type !== 'franchise' || second.vertical_stage !== 'lead_received' ||
      replay.result_code !== 'already_processed' || first.lead_id !== second.lead_id ||
      outbound !== 0) {
      throw new Error(`unexpected HTTP flow: ${JSON.stringify({ first: first.result_code,
        second: second.result_code, replay: replay.result_code, route: second.route_type,
        stage: second.vertical_stage, outbound })}`);
    }
    process.stdout.write('PASS: handler -> local REST RPC -> PostgreSQL -> franchise; replay stable; outbound 0\n');
  } finally {
    sql(`delete from public.social_classifications where organization_id='${org}';
      delete from public.social_lead_stage_history where organization_id='${org}';
      delete from public.social_engagements where organization_id='${org}';
      delete from public.social_leads where organization_id='${org}';
      delete from public.social_contacts where organization_id='${org}';
      delete from public.instagram_accounts where id='${account}';
      delete from public.organizations where id='${org}';`);
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
