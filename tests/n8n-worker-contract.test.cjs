const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflowPath = path.join(root, 'n8n', 'workflows', 'ig-social-selling-orchestrator.json');

test('versioned n8n worker is importable, secret-free and fail-safe', () => {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const workflow = JSON.parse(raw);
  const names = new Set(workflow.nodes.map(node => node.name));
  assert.deepEqual([...names], [
    'Poll queue', 'Claim next job', 'Gate claimed job', 'Process engagement',
    'Decode pipeline response', 'Gemini required?', 'Classify with connected Gemini',
    'Prepare Gemini completion', 'Complete with Gemini', 'Normalize outcome',
    'Draft eligible?', 'Prepare response draft', 'Decode draft request', 'Draft required?',
    'Draft with connected Gemini', 'Prepare draft completion', 'Save proposed response',
    'Decode draft persistence', 'Finalize job',
  ]);
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.doesNotMatch(raw, /\$env\./);
  assert.equal(workflow.nodes.filter(node => node.type === "n8n-nodes-base.httpRequest")
    .every(node => node.parameters.authentication === "genericCredentialType" &&
      node.parameters.genericAuthType === "httpHeaderAuth" &&
      node.credentials?.httpHeaderAuth?.name === "PHIQ Supabase Worker"), true);
  const geminiNodes = workflow.nodes.filter(node =>
    node.type === '@n8n/n8n-nodes-langchain.googleGemini');
  assert.equal(geminiNodes.length, 2);
  assert.deepEqual(geminiNodes.map(node => node.parameters.modelId.value), [
    'models/gemini-3.5-flash-lite',
    'models/gemini-3.6-flash',
  ]);
  assert.equal(geminiNodes.every(node =>
    node.credentials.googlePalmApi.name === 'Google Gemini(PaLM) Api account' &&
    node.retryOnFail === true &&
    node.maxTries === 3 &&
    node.waitBetweenTries === 1000 &&
    node.onError === 'continueRegularOutput'), true);
  assert.equal(workflow.connections['Gemini required?'].main[0][0].node,
    'Classify with connected Gemini');
  assert.equal(workflow.connections['Gemini required?'].main[1][0].node,
    'Normalize outcome');
  assert.equal(workflow.connections['Complete with Gemini'].main[0][0].node,
    'Normalize outcome');
  assert.equal(workflow.connections['Normalize outcome'].main[0][0].node,
    'Draft eligible?');
  assert.equal(workflow.connections['Draft eligible?'].main[0][0].node,
    'Prepare response draft');
  assert.equal(workflow.connections['Draft eligible?'].main[1][0].node,
    'Finalize job');
  assert.equal(workflow.connections['Draft required?'].main[0][0].node,
    'Draft with connected Gemini');
  assert.equal(workflow.connections['Draft required?'].main[1][0].node,
    'Finalize job');
  assert.equal(workflow.connections['Decode draft persistence'].main[0][0].node,
    'Finalize job');
  assert.doesNotMatch(raw, /x-worker-secret/i);
  assert.doesNotMatch(raw, /openai|OPENAI_API_KEY/i);
  assert.match(raw, /n8n-claim-instagram-job/);
  assert.match(raw, /process-social-engagement/);
  assert.match(raw, /n8n-prepare-instagram-draft/);
  assert.match(raw, /n8n-save-instagram-draft/);
  assert.match(raw, /n8n-update-instagram-job/);
  assert.match(raw, /dead_letter/);
  assert.match(raw, /retry_after_seconds/);
  assert.match(raw, /classification_required/);
  assert.doesNotMatch(raw, /(?:sk-|re_)[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(raw, /SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY/);
});

test('terminal job handling is atomic and restricted to service role', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations',
    '20261028234500_add_terminal_processing_job_dead_letter.sql'), 'utf8');
  const endpoint = fs.readFileSync(path.join(root, 'supabase', 'functions',
    'n8n-update-instagram-job', 'index.ts'), 'utf8');
  assert.match(migration, /where id = p_job_id[\s\S]*status = 'processing'[\s\S]*locked_by = p_worker_id/i);
  assert.match(migration, /set status = 'dead_letter'/i);
  assert.match(migration, /revoke all[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*service_role/i);
  assert.match(endpoint, /dead_letter_processing_job/);
  assert.match(endpoint, /\["complete", "fail", "dead_letter"\]/);
});

test('claim gate accepts serialized JSON returned by n8n full response mode', () => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const gateCode = workflow.nodes.find(node => node.name === 'Gate claimed job').parameters.jsCode;
  const executeGate = new Function('$input', gateCode);

  assert.deepEqual(executeGate({
    first: () => ({ json: { statusCode: 200, body: JSON.stringify({ ok: true, job: null }) } }),
  }), []);

  const job = { id: 'job-1', locked_by: 'worker-1', attempts: 1 };
  const engagement = { organization_id: 'org-1', engagement_type: 'comment' };
  assert.deepEqual(executeGate({
    first: () => ({
      json: { statusCode: 200, body: JSON.stringify({ ok: true, job, engagement }) },
    }),
  }), [{ json: { claim: { ok: true, job, engagement }, engagement } }]);

  const streamEnvelope = {
    _readableState: {
      buffer: [{ type: 'Buffer', data: [...Buffer.from(JSON.stringify({ ok: true, job: null }))] }],
    },
  };
  assert.deepEqual(executeGate({
    first: () => ({ json: { statusCode: 200, body: streamEnvelope } }),
  }), []);

  const nestedStreamEnvelope = {
    body: {
      _readableState: {
        buffer: {
          head: {
            data: [...Buffer.from(JSON.stringify({ ok: true, job: null }))],
          },
        },
      },
    },
  };
  assert.deepEqual(executeGate({
    first: () => ({ json: { statusCode: 200, data: nestedStreamEnvelope } }),
  }), []);

  const fragmentedPayload = Buffer.from(JSON.stringify({ ok: true, job: null }));
  const splitAt = Math.floor(fragmentedPayload.length / 2);
  const numericObject = bytes => Object.fromEntries([...bytes].map((byte, index) => [index, byte]));
  const fragmentedStreamEnvelope = {
    _readableState: {
      buffer: {
        0: { type: 'Buffer', data: numericObject(fragmentedPayload.subarray(0, splitAt)) },
        1: { type: 'Buffer', data: numericObject(fragmentedPayload.subarray(splitAt)) },
      },
    },
  };
  assert.deepEqual(executeGate({
    first: () => ({ json: { statusCode: 200, body: fragmentedStreamEnvelope } }),
  }), []);

  assert.deepEqual(executeGate({
    first: () => ({
      json: {
        statusCode: 200,
        body: { data: JSON.stringify({ ok: true, job: null }) },
      },
    }),
  }), []);
});

test('all HTTP response decoders accept fragmented numeric Buffer objects', () => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const codeFor = name => workflow.nodes.find(node => node.name === name).parameters.jsCode;
  const fragmentedEnvelope = payload => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const first = bytes.subarray(0, Math.floor(bytes.length / 2));
    const second = bytes.subarray(first.length);
    const numericObject = chunk => Object.fromEntries(
      [...chunk].map((byte, index) => [index, byte]),
    );
    return {
      _readableState: {
        buffer: {
          0: { type: 'Buffer', data: numericObject(first) },
          1: { type: 'Buffer', data: numericObject(second) },
        },
      },
    };
  };
  const input = json => ({ first: () => ({ json }) });
  const gate = {
    claim: { job: { id: 'job-2', locked_by: 'worker-2', attempts: 1 } },
    engagement: { engagement_type: 'comment' },
  };
  const lookup = name => ({ first: () => ({ json: name === 'Gate claimed job' ? gate : {
    action: 'complete', job_id: 'job-2', worker_id: 'worker-2', error: '',
  } }) });

  const decodePipeline = new Function('$input', '$', codeFor('Decode pipeline response'));
  const decoded = decodePipeline(input({
    statusCode: 200,
    body: fragmentedEnvelope({
      result_code: 'classification_required',
      classifier_request: { prompt: 'fixture' },
    }),
  }), lookup);
  assert.equal(decoded[0].json.needs_model, true);
  assert.equal(decoded[0].json.pipeline_response.result_code, 'classification_required');

  const normalize = new Function('$input', '$', codeFor('Normalize outcome'));
  const normalized = normalize(input({
    pipeline_status: 200,
    pipeline_response: fragmentedEnvelope({ result_code: 'classified' }),
  }), lookup);
  assert.equal(normalized[0].json.action, 'complete');
  assert.equal(normalized[0].json.draft_eligible, true);

  const decodeDraft = new Function('$input', '$', codeFor('Decode draft request'));
  const prepared = decodeDraft(input({
    statusCode: 200,
    body: fragmentedEnvelope({ ok: true, draft_required: false }),
  }), lookup);
  assert.equal(prepared[0].json.draft_required, false);
  assert.equal(prepared[0].json.action, 'complete');

  const decodePersistence = new Function('$input', '$', codeFor('Decode draft persistence'));
  const persisted = decodePersistence(input({
    statusCode: 200,
    body: fragmentedEnvelope({ ok: true }),
  }), lookup);
  assert.equal(persisted[0].json.action, 'complete');
  assert.equal(persisted[0].json.draft_saved, true);
});
