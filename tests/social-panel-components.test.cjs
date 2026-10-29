const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('../panel-web/node_modules/react');
const { renderToStaticMarkup } = require('../panel-web/node_modules/react-dom/server');
const ts = require('../panel-web/node_modules/typescript');

function compile(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: key => key === 'react/jsx-runtime'
    ? require('../panel-web/node_modules/react/jsx-runtime') : mocks[key] ?? {},
    Date, Intl, URLSearchParams, console, React }, { filename: file });
  return exports;
}
const types = compile('panel-web/src/lib/api/socialCrmTypes.ts');
const presentation = compile('panel-web/src/lib/api/socialCrmPresentation.ts', {
  './socialCrmTypes': types,
});
const simple = tag => ({ children, ...props }) => React.createElement(tag, {
  ...Object.fromEntries(Object.entries(props).filter(([key]) => !['variant', 'size', 'asChild'].includes(key))),
}, children);
const Link = ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children);
const NavLink = ({ to, children, className }) => React.createElement('a', {
  href: to, className: typeof className === 'function' ? className({ isActive: false }) : className,
}, children);
const Badge = simple('span');
const card = compile('panel-web/src/components/social/SocialLeadCard.tsx', {
  react: React, 'react-router': { Link }, '@/components/ui/badge': { Badge },
  '@/lib/api/socialCrmPresentation': presentation,
});

function lead(patch = {}) {
  return {
    id: 'lead-1', username: 'maria', display_name: 'Maria Silva',
    route_type: 'franchise', vertical_stage: 'presentation', central_stage: 'routing',
    status: 'active', owner_email: null, lead_score: 80, route_confidence: 0.92,
    last_source: 'realtime', classification_status: 'completed',
    contact_eligibility: 'unknown', recommended_next_action: 'present_franchise',
    last_interaction_at: '2026-09-28T12:00:00Z', ...patch,
  };
}

test('lead card shows canonical route/stage, source, score and eligibility separately', () => {
  const html = renderToStaticMarkup(React.createElement(card.SocialLeadCard, { lead: lead() }));
  for (const text of ['@maria', 'Maria Silva', 'Franquia', 'Apresentação', 'Realtime',
    '80', '92%', 'Desconhecida', 'Sem responsável', 'Apresentar franquia']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('/social-selling/lead/lead-1'));
});

test('no_profile card stays awaiting signal and historical source remains visible', () => {
  const html = renderToStaticMarkup(React.createElement(card.SocialLeadCard, { lead: lead({
    route_type: 'no_profile', vertical_stage: null, status: 'awaiting_signal',
    last_source: 'historical_backfill', contact_eligibility: 'ineligible',
    recommended_next_action: 'await_new_signal',
  }) }));
  for (const text of ['Sem perfil', 'Aguardando sinal', 'Histórico', 'Não elegível', 'Aguardar novo sinal'])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Perdido'));
});

const dashboard = { kpis: {
  active: 5, new_leads: 1, qualification: 2, routed: 4, no_profile: 1,
  franchise: 1, q3: 1, hotmart: 1, nuy: 1, won: 1, lost: 1,
  awaiting_signal: 1, unassigned: 2, classification_pending: 1, needs_action: 2,
}, recent_interactions: [{ id: 'lead-1', username: 'maria', last_source: 'realtime',
  last_interaction_at: '2026-09-28T12:00:00Z' }],
unassigned_leads: [{ id: 'lead-1', username: 'maria', route_type: 'franchise' }],
pending_leads: [{ id: 'lead-2', username: 'joao', classification_status: 'failed_retryable',
  pipeline_error_code: 'classifier_timeout' }] };
let mode = 'overview';
let result = { data: dashboard, isPending: false, isError: false };
let queryParams = new URLSearchParams();
const Icons = new Proxy({}, { get: () => simple('span') });
const panel = compile('panel-web/src/pages/SocialSellingPage.tsx', {
  react: React, '@tanstack/react-query': { useQuery: ({ queryKey }) =>
    queryKey.includes('members') ? { data: [] } : result },
  'lucide-react': Icons,
  'react-router': { Link, NavLink, useSearchParams: () => [queryParams, () => {}] },
  '@/components/layout/AppShell': { AppShell: simple('div') },
  '@/components/social/SocialLeadCard': card,
  '@/components/ui/badge': { Badge }, '@/components/ui/button': { Button: simple('button') },
  '@/components/ui/card': { Card: simple('div'), CardContent: simple('div'),
    CardHeader: simple('div'), CardTitle: simple('h2') },
  '@/components/ui/input': { Input: simple('input') },
  '@/components/ui/skeleton': { Skeleton: simple('div') },
  '@/context/OrganizationProvider': { useOrganization: () => ({ organizationId: 'org-1' }) },
  '@/hooks/useMemberships': { useMemberships: () => ({ data: { memberships: [{ organization_id: 'org-1', role: 'admin' }] } }) },
  '@/lib/api/socialCrmApi': { socialCrmApi: {} },
  '@/lib/api/socialCrmPresentation': presentation,
  '@/lib/api/socialCrmTypes': types,
});

test('dashboard renders database KPI values and pending/error sections', () => {
  mode = 'overview'; result = { data: dashboard, isPending: false, isError: false };
  const html = renderToStaticMarkup(React.createElement(panel.SocialOverviewPage));
  for (const text of ['Leads ativos', 'Em qualificação', 'Franquia', 'Q3', 'Hotmart',
    'Nuy', 'Ganhos', 'Perdidos', 'Aguardando sinal', 'Interações recentes',
    'Sem responsável', 'Classificação pendente', 'classifier_timeout', 'Outbound desativado'])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Enviar DM'));
});

test('all four vertical boards render their canonical stages', () => {
  for (const route of ['franchise', 'q3', 'hotmart', 'nuy']) {
    mode = route;
    queryParams = new URLSearchParams({ route });
    result = { data: { leads: [lead({ route_type: route, vertical_stage: 'lead_received' })], total: 1 },
      isPending: false, isError: false };
    const html = renderToStaticMarkup(React.createElement(panel.SocialFunnelPage));
    for (const stage of types.getVerticalStages(route)) assert.ok(html.includes(stage.label), `${route}:${stage.label}`);
    assert.ok(html.includes('Ver todos nesta etapa'));
  }
});

test('list renders a real filtered row with route, status and source', () => {
  mode = 'list'; queryParams = new URLSearchParams({ route: 'franchise', status: 'active', search: 'maria' });
  result = { data: { leads: [lead()], total: 1 }, isPending: false, isError: false };
  const html = renderToStaticMarkup(React.createElement(panel.SocialLeadsPage));
  assert.ok(html.includes('value="maria"'));
  assert.ok(html.includes('@maria'));
  assert.ok(html.includes('Franquia'));
  assert.ok(html.includes('Realtime'));
  assert.ok(html.includes('1 leads encontrados'));
});
