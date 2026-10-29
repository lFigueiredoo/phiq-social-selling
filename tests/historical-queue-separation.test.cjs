const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('database queue normalizes and filters realtime and historical sources', () => {
  const sql = read('supabase/migrations/20261029084500_separate_historical_outbound_queue.sql');

  assert.match(sql, /p_source text default null/i);
  assert.match(sql, /we\.payload ->> 'source' = 'historical_backfill'/i);
  assert.match(sql, /else 'realtime'::text/i);
  assert.match(sql, /p_source is null[\s\S]*end = p_source/i);
  assert.match(sql, /invalid source filter/i);
  assert.match(sql, /revoke all[\s\S]*authenticated/i);
  assert.match(sql, /grant execute[\s\S]*service_role/i);
});

test('panel API validates, forwards and returns the action source', () => {
  const edge = read('supabase/functions/panel-list-actions/index.ts');
  const client = read('panel-web/src/lib/api/panelListActions.ts');
  const types = read('panel-web/src/lib/api/types.ts');

  assert.match(edge, /const SOURCES = new Set\(\["realtime", "historical_backfill"\]\)/);
  assert.match(edge, /url\.searchParams\.get\("source"\)/);
  assert.match(edge, /p_source: source/);
  assert.match(edge, /source: r\.source/);
  assert.match(client, /source: filters\.source/);
  assert.match(types, /export type ActionSource = "realtime" \| "historical_backfill"/);
});

test('new and historical comments use distinct protected queues in the UI', () => {
  const queue = read('panel-web/src/pages/QueuePage.tsx');
  const router = read('panel-web/src/router.tsx');
  const tabs = read('panel-web/src/components/historical/HistoricalTabs.tsx');

  assert.match(queue, /ApprovalQueuePage source="realtime"/);
  assert.match(queue, /ApprovalQueuePage source="historical_backfill" historical/);
  assert.match(queue, /Comentários históricos não iniciam Direct automático/);
  assert.match(router, /path="\/historico\/respostas"[\s\S]*<AdminOnly>/);
  assert.match(tabs, /to: "\/historico"/);
  assert.match(tabs, /to: "\/historico\/respostas"/);
});
