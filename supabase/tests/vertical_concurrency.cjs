// Local PostgreSQL concurrency check; creates and removes its own fixture.
const { randomUUID } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");

const org = randomUUID();
const account = randomUUID();
const dbArgs = ["exec", "-i", "supabase_db_social-selling-ig", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"];
function sql(query) {
  return execFileSync("docker", dbArgs, { input: query, encoding: "utf8" }).trim();
}
function asyncSql(query) {
  return new Promise((resolve) => {
    const child = execFile("docker", dbArgs, { encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }));
    child.stdin.end(query);
  });
}

(async () => {
  let lead;
  try {
    lead = sql(`
      insert into public.organizations(id,name) values ('${org}','f22e-concurrency');
      insert into public.instagram_accounts(id,organization_id,external_id,status)
        values ('${account}','${org}','f22e-concurrency','active');
      with contact as (
        select public.upsert_social_contact('${org}','${account}','concurrency-user',null) id
      ), new_lead as (
        select public.get_or_create_social_lead('${org}',id) id from contact
      ) select id from new_lead;
    `).split(/\r?\n/).at(-1);
    sql(`
      select public.transition_social_lead_stage('${org}','${lead}','central','first_contact','fixture','system','system');
      select public.transition_social_lead_stage('${org}','${lead}','central','qualification','fixture','system','system');
      select public.transition_social_lead_stage('${org}','${lead}','central','routing','fixture','system','system');
      select public.route_social_lead('${org}','${lead}','franchise',0.9,80,'fixture','human_review','system','system');
    `);
    const requests = ["worker-a", "worker-b"].map((key) => asyncSql(`
      select public.transition_vertical_lead_stage('${org}','${lead}',
        'lead_received','presentation','${key}','simultaneous worker');
    `));
    const results = await Promise.all(requests);
    const successes = results.filter((result) => !result.error).length;
    const stale = results.filter((result) => result.error && result.stderr.includes("invalid_vertical_transition")).length;
    const state = sql(`select vertical_stage || ':' ||
      (select count(*) from public.social_lead_stage_history where lead_id='${lead}'
        and operation_key in ('worker-a','worker-b'))
      from public.social_leads where id='${lead}';`).split(/\r?\n/).at(-1);
    if (successes !== 1 || stale !== 1 || state !== "presentation:1") {
      throw new Error(`concurrency failed: successes=${successes}, stale=${stale}, state=${state}`);
    }
    process.stdout.write("PASS: one concurrent transition, one stale rejection, one history row\n");
  } finally {
    if (lead) {
      sql(`delete from public.social_lead_stage_history where lead_id='${lead}';
        delete from public.social_leads where id='${lead}';
        delete from public.social_contacts where organization_id='${org}';
        delete from public.instagram_accounts where id='${account}';
        delete from public.organizations where id='${org}';`);
    }
  }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
