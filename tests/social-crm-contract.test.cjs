const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('supabase/migrations/20260927114318_social_crm_core.sql');
const centralMigration = read('supabase/migrations/20260927120930_central_funnel_engine.sql');

test('realtime and historical paths converge on the same CRM RPC', () => {
  for (const source of [
    'supabase/functions/meta-instagram-webhook/index.ts',
    'supabase/functions/panel-import-instagram-comments/index.ts',
  ]) {
    assert.match(read(source), /\.rpc\("ingest_social_comment_event"/);
  }
  assert.match(migration, /create function public\.ingest_social_comment_event/);
  assert.match(migration, /public\.upsert_social_contact/);
  assert.match(migration, /public\.record_social_engagement/);
  assert.match(migration, /public\.get_or_create_social_lead/);
});

test('CRM migration is backend only and contains no outbound dispatch', () => {
  for (const table of ['social_contacts', 'social_engagements', 'social_leads', 'social_lead_stage_history']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /from public, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /\boutbound_actions\b|\bdispatch_instagram\b|\bmeta_access_token\b/i);
  assert.doesNotMatch(read('supabase/functions/meta-instagram-webhook/index.ts'), /n8n-dispatch-instagram-action/);
  assert.doesNotMatch(read('supabase/functions/panel-import-instagram-comments/index.ts'), /n8n-dispatch-instagram-action/);
});

test('SQL integration suite covers identity, stages, tenants and historical source', () => {
  const sql = read('supabase/tests/social_crm_core.sql');
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^rollback;/m);
  for (const topic of ['username fallback', 'external ID priority', 'duplicate active lead', 'historical source', 'invalid vertical transition', 'cross-tenant transition', 'outbound action']) {
    assert.ok(sql.includes(topic), topic);
  }
});

test('central engine uses one policy and contains no outbound or model calls', () => {
  assert.match(centralMigration, /create table public\.social_central_transitions/);
  assert.match(centralMigration, /create function public\.process_social_engagement/);
  assert.match(centralMigration, /create function public\.apply_social_assessment/);
  assert.match(centralMigration, /create function public\.manual_override_social_lead/);
  assert.match(centralMigration, /create table public\.social_funnel_policies/);
  assert.doesNotMatch(centralMigration, /\boutbound_actions\b|\bdispatch_instagram\b|https?:\/\/|gemini|openai/i);
  const sql = read('supabase/tests/central_funnel_engine.sql');
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^rollback;/m);
  assert.match(sql, /old engagement replay caused requalification/);
  assert.match(sql, /legacy actor-less override accepted/);
});
