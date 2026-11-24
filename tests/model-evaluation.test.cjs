const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../panel-web/node_modules/typescript');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/_shared/socialClassifier.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const classifier = {};
vm.runInNewContext(js, { exports: classifier, require() { return {}; }, JSON, console }, { filename: 'socialClassifier.ts' });
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/social-model-evaluation.json'), 'utf8'));

test('versioned social-selling evaluation set blocks false-positive commercial routing', async () => {
  let correctRoutes = 0;
  let falseCommercialRoutes = 0;
  for (const fixture of fixtures) {
    const result = await classifier.classifySocialLeadContext({
      currentText: fixture.text, mediaContext: fixture.media, recentInteractions: [],
      source: 'realtime', engagementCount: 1,
    });
    if (result.classification.route_type === fixture.route) correctRoutes++;
    if (!fixture.commercial && result.classification.route_type !== 'no_profile') falseCommercialRoutes++;
  }
  assert.equal(correctRoutes / fixtures.length, 1);
  assert.equal(falseCommercialRoutes, 0);
});

