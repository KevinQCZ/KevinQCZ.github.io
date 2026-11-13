import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertUnchanged, createDeploymentConfig, readProductionState,
  validateState, validateTarget, withTemporaryConfig, wranglerArguments
} from './deploy-worker.mjs';

const accountId = 'a'.repeat(32);
const version = '11111111-1111-4111-8111-111111111111';
const databaseId = '22222222-2222-4222-8222-222222222222';
const run = promisify(execFile);
const fixture = () => ({
  settings: {
    bindings: [
      ...['ADMIN_GITHUB_IDS', 'API_ORIGIN', 'GITHUB_APP_ID',
        'GITHUB_APP_INSTALLATION_ID', 'GITHUB_CLIENT_ID', 'SITE_ORIGIN']
        .map((name) => ({ name, type: 'plain_text', text: `test-only-${name}` })),
      ...['CSRF_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_SECRET']
        .map((name) => ({ name, type: 'secret_text' })),
      { name: 'DB', type: 'd1', id: databaseId, database_id: databaseId },
      ...['AUTH_RATE_LIMITER', 'WRITE_RATE_LIMITER'].map((name, index) => ({
        name, type: 'ratelimit', namespace_id: `${index + 100}`,
        simple: { limit: 10, period: 60 }
      }))
    ],
    placement: {},
    compatibility_date: '2026-10-01',
    compatibility_flags: [],
    usage_model: 'standard',
    tags: [],
    tail_consumers: [],
    logpush: false,
    observability: {
      enabled: false, head_sampling_rate: 1, redact_query_string: false,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: false, head_sampling_rate: 1, persist: true }
    },
    annotations: { 'workers/triggered_by': 'version_upload' }
  },
  subdomain: { enabled: true, previews_enabled: false },
  routes: [], domains: [], version
});

test('maps existing resources and runtime settings without serializing variables or credentials', () => {
  const state = fixture();
  const config = createDeploymentConfig(state, accountId);
  assert.equal(config.name, 'kevinqcz-github-io');
  assert.ok(config.main.endsWith(path.join('worker', 'src', 'index.ts')));
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_id: databaseId }]);
  assert.deepEqual(config.ratelimits, state.settings.bindings
    .filter((binding) => binding.type === 'ratelimit')
    .map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })));
  assert.deepEqual(config.observability, state.settings.observability);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars, undefined);
  assert.equal(config.secrets, undefined);
  assert.equal(JSON.stringify(config).includes('test-only'), false);
});

test('rejects unknown, missing, duplicate or mismatched bindings and unsupported remote settings', () => {
  for (const change of [
    (state) => state.settings.bindings.push({ name: 'EXTRA', type: 'kv_namespace', namespace_id: 'test' }),
    (state) => state.settings.bindings.pop(),
    (state) => state.settings.bindings.push(state.settings.bindings[0]),
    (state) => { state.settings.bindings.find((binding) => binding.name === 'DB').id = version; },
    (state) => { state.settings.bindings.find((binding) => binding.type === 'secret_text').text = 'must-not-log'; },
    (state) => { state.settings.placement = { mode: 'smart' }; },
    (state) => { state.settings.observability.unknown_option = true; },
    (state) => { state.settings.unsafe = { enabled: true }; },
    (state) => state.routes.push({ pattern: '*.example.test/*' }),
    (state) => state.domains.push({ hostname: 'api.example.test' })
  ]) {
    const state = fixture();
    change(state);
    assert.throws(() => validateState(state), /metadata|binding names/);
  }
});

test('detects runtime or version drift without exposing changed values', () => {
  const before = fixture();
  for (const change of [
    (state) => { state.settings.bindings[0].text = 'do-not-print-this-value'; },
    (state) => { state.settings.bindings.find((binding) => binding.type === 'ratelimit').namespace_id = '999'; },
    (state) => { state.subdomain.previews_enabled = true; },
    (state) => { state.version = databaseId; }
  ]) {
    const after = fixture();
    change(after);
    assert.throws(() => assertUnchanged(before, after), (error) =>
      error.message.includes('changed') && !error.message.includes('do-not-print-this-value'));
  }
  const after = fixture();
  after.version = databaseId;
  after.settings.annotations = { 'workers/triggered_by': 'deployment' };
  after.settings.bindings.reverse();
  assert.doesNotThrow(() => assertUnchanged(before, after, { allowNewVersion: true }));
});

test('rejects account/Worker mismatches, offline writes and non-master production deployment', () => {
  const env = {
    CLOUDFLARE_API_TOKEN: 'test-only-token', WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'master', CLOUDFLARE_ACCOUNT_ID: accountId
  };
  assert.equal(validateTarget({}, env), accountId);
  assert.throws(() => validateTarget({ accountId: 'b'.repeat(32) }, env), /target/);
  assert.throws(() => validateTarget({}, { ...env, WRANGLER_CI_OVERRIDE_NAME: 'another-worker' }), /target/);
  assert.throws(() => validateTarget({}, { ...env, WORKERS_CI_BRANCH: 'feature' }), /master/);
  assert.throws(() => validateTarget({ metadataFile: 'fixture.json' }, env), /only with --dry-run/);
  assert.throws(() => validateTarget({}, { ...env, CLOUDFLARE_API_TOKEN: '' }), /required/);
});

test('metadata API failures stop before deployment and redact provider diagnostics', async () => {
  const token = 'never-print-this-token';
  await assert.rejects(
    readProductionState(accountId, token, async () => new Response(token, { status: 403 })),
    (error) => error.message.includes('HTTP 403') && !error.message.includes(token)
  );
  await assert.rejects(
    readProductionState(accountId, token, async () => { throw new Error(token); }),
    (error) => error.message.includes('connectivity') && !error.message.includes(token)
  );
});

function productionFetch(state) {
  return async (url, init) => {
    assert.equal(init.method, undefined);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    let result;
    if (url.endsWith('/settings')) result = state.settings;
    else if (url.endsWith('/subdomain')) result = state.subdomain;
    else if (url.endsWith('/routes') || url.endsWith('/domains')) result = [];
    else if (url.endsWith('/deployments')) result = {
      deployments: [{ created_on: '2026-11-13T00:00:00Z', versions: [{ version_id: version, percentage: 100 }] }]
    };
    else if (url.endsWith(`/versions/${version}`)) result = {
      id: version,
      resources: {
        script_runtime: { compatibility_date: state.settings.compatibility_date, usage_model: 'standard' },
        bindings: state.settings.bindings.map((binding) => {
          if (binding.type !== 'd1') return binding;
          const { database_id, ...rest } = binding;
          return rest;
        })
      }
    };
    else assert.fail('Unexpected endpoint');
    return Response.json({ success: true, result });
  };
}

test('reads existing production state using only authenticated GET requests', async () => {
  const state = fixture();
  const fakeFetch = productionFetch(state);
  assert.deepEqual(await readProductionState(accountId, 'test-token', fakeFetch), state);
});

function paginatedFetch(state, adjust = () => {}) {
  const fallback = productionFetch(state);
  return async (url, init) => {
    const parsedUrl = new URL(url);
    if (!parsedUrl.pathname.endsWith('/deployments')) return fallback(url, init);
    assert.equal(init.method, undefined);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const page = Number(parsedUrl.searchParams.get('page') ?? 1);
    if (page === 2) assert.equal(parsedUrl.searchParams.get('per_page'), '1');
    const envelope = {
      success: true,
      result: {
        deployments: [{
          id: `deployment-${page}`,
          created_on: page === 1 ? '2026-11-12T00:00:00Z' : '2026-11-13T00:00:00Z',
          versions: [{ version_id: page === 1 ? databaseId : version, percentage: 100 }]
        }]
      },
      result_info: { page, per_page: 1, count: 1, total_count: 2, total_pages: 2 }
    };
    if (page === 2) adjust(envelope);
    return Response.json(envelope);
  };
}

test('reads every deployment-history page before selecting the active version', async () => {
  const state = fixture();
  assert.deepEqual(await readProductionState(accountId, 'test-token', paginatedFetch(state)), state);
});

test('rejects changed, missing, duplicate or incomplete deployment-history pages', async () => {
  for (const adjust of [
    (envelope) => { envelope.result_info.total_count = 3; },
    (envelope) => { delete envelope.result_info; },
    (envelope) => { envelope.result.deployments[0].id = 'deployment-1'; },
    (envelope) => { envelope.result.deployments = []; envelope.result_info.count = 0; }
  ]) {
    await assert.rejects(
      readProductionState(accountId, 'test-token', paginatedFetch(fixture(), adjust)),
      /pagination.*(incomplete|changed)/
    );
  }
});

test('temporary configuration is removed on success and on validation failure', async () => {
  let generated;
  await withTemporaryConfig(createDeploymentConfig(fixture(), accountId), async (configPath) => {
    generated = configPath;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.keep_vars, true);
    assert.ok(wranglerArguments(configPath, true).includes('--autoconfig=false'));
    assert.ok(wranglerArguments(configPath, true).includes('--strict'));
    assert.ok(wranglerArguments(configPath, true).includes('--dry-run'));
  });
  await assert.rejects(access(generated), { code: 'ENOENT' });
  await assert.rejects(withTemporaryConfig({}, async (configPath) => {
    generated = configPath;
    throw new Error('test failure');
  }), /test failure/);
  await assert.rejects(access(generated), { code: 'ENOENT' });
});

test('offline dry-run compiles the real Worker without changing Astro configuration', async () => {
  const configUrl = new URL('../astro.config.mjs', import.meta.url);
  const before = await readFile(configUrl, 'utf8');
  await withTemporaryConfig({}, async (configPath) => {
    const metadataPath = path.join(path.dirname(configPath), 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(fixture()));
    const { stdout, stderr } = await run(process.execPath, [
      'scripts/deploy-worker.mjs', '--dry-run', '--metadata-file', metadataPath, '--account-id', accountId
    ], {
      timeout: 60000,
      env: {
        ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: '',
        WRANGLER_CI_OVERRIDE_NAME: 'kevinqcz-github-io'
      }
    });
    assert.match(stdout, /dry-run passed/);
    assert.equal(`${stdout}${stderr}`.includes('test-only'), false);
  });
  assert.equal(await readFile(configUrl, 'utf8'), before);
});
