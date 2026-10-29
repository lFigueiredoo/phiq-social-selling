// Two workers process one engagement against local PostgreSQL; fixture is removed.
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const org = randomUUID();
const account = randomUUID();
const args = ['exec', '-i', 'supabase_db_social-selling-ig', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'postgres', '-At'];
function sql(query) {
  return execFileSync('docker', args, { input: query, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
}
function asyncSql(query) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { encoding: 'utf8' }, (error, out, err) =>
      error ? reject(new Error(err || error.message)) : resolve(out.trim().split(/\r?\n/).at(-1)));
    child.stdin.end(query);
  });
}
function input(identity) {
  return JSON.stringify({ organization_id: org, instagram_account_id: account,
    external_user_id: 'f22f-concurrency', engagement_type: 'comment', source: 'realtime',
    external_engagement_id: identity, text: 'Quero abrir uma franquia' }).replaceAll("'", "''");
}
const classification = JSON.stringify({ intent: 'franchise_interest', commercial_potential: 'high',
  lead_score: 80, route_type: 'franchise', confidence: 0.92, reason: 'explicit request',
  recommended_next_action: 'human_review', signals: ['explicit_current_request'],
  needs_more_signal: false }).replaceAll("'", "''");

(async () => {
  try {
    sql(`insert into public.organizations(id,name) values('${org}','f22f-concurrency');
      insert into public.instagram_accounts(id,organization_id,external_id,status)
        values('${account}','${org}','f22f-concurrency','active');`);
    const first = JSON.parse(sql(`select public.prepare_social_engagement_pipeline('${input('first')}'::jsonb);`));
    sql(`select public.complete_social_engagement_pipeline('${org}','${first.lead_id}',
      '${first.engagement_id}','${classification}'::jsonb,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');`);
    const worker = async () => {
      const prepared = JSON.parse(await asyncSql(`select public.prepare_social_engagement_pipeline('${input('second')}'::jsonb);`));
      if (prepared.result_code === 'already_processed') return prepared.result_code;
      const done = JSON.parse(await asyncSql(`select public.complete_social_engagement_pipeline('${org}',
        '${prepared.lead_id}','${prepared.engagement_id}','${classification}'::jsonb,
        'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');`));
      return done.result_code;
    };
    const results = await Promise.all([worker(), worker()]);
    const state = JSON.parse(sql(`select jsonb_build_object(
      'engagements',(select count(*) from public.social_engagements where organization_id='${org}'),
      'leads',(select count(*) from public.social_leads where organization_id='${org}'),
      'classifications',(select count(*) from public.social_classifications where organization_id='${org}'),
      'route_history',(select count(*) from public.social_lead_stage_history
        where organization_id='${org}' and pipeline='franchise' and to_stage='lead_received'),
      'route',(select route_type from public.social_leads where id='${first.lead_id}'),
      'stage',(select vertical_stage from public.social_leads where id='${first.lead_id}'));`));
    if (!results.includes('routed') || !results.includes('already_processed') ||
      state.engagements !== 2 || state.leads !== 1 || state.classifications !== 2 ||
      state.route_history !== 1 || state.route !== 'franchise' || state.stage !== 'lead_received') {
      throw new Error(`unexpected concurrent state: ${JSON.stringify({ results, state })}`);
    }
    process.stdout.write('PASS: two workers, one route application, one replay, one lead\n');
  } finally {
    sql(`delete from public.social_classifications where organization_id='${org}';
      delete from public.social_lead_stage_history where organization_id='${org}';
      delete from public.social_engagements where organization_id='${org}';
      delete from public.social_leads where organization_id='${org}';
      delete from public.social_contacts where organization_id='${org}';
      delete from public.instagram_accounts where id='${account}';
      delete from public.organizations where id='${org}';`);
  }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
