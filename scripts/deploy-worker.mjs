import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerName = 'kevinqcz-github-io';
const variableNames = [
  'ADMIN_GITHUB_IDS', 'API_ORIGIN', 'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID', 'GITHUB_CLIENT_ID', 'SITE_ORIGIN'
];
const secretNames = ['CSRF_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_SECRET'];
const bindingNames = [...variableNames, ...secretNames, 'DB', 'AUTH_RATE_LIMITER', 'WRITE_RATE_LIMITER'];
const emptyList = z.array(z.never());
const sampleRate = z.number().min(0).max(1);
const telemetry = z.strictObject({
  enabled: z.boolean(),
  head_sampling_rate: sampleRate,
  persist: z.boolean(),
  invocation_logs: z.boolean().optional(),
  destinations: emptyList.optional()
});
const bindingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('plain_text'), name: z.enum(variableNames), text: z.string().min(1) }),
  z.strictObject({ type: z.literal('secret_text'), name: z.enum(secretNames) }),
  z.strictObject({
    type: z.literal('d1'), name: z.literal('DB'),
    database_id: z.uuid(), id: z.uuid()
  }).refine((binding) => binding.id === binding.database_id),
  z.strictObject({
    type: z.literal('ratelimit'), name: z.enum(['AUTH_RATE_LIMITER', 'WRITE_RATE_LIMITER']),
    namespace_id: z.string().regex(/^\d+$/),
    simple: z.strictObject({ limit: z.number().int().positive(), period: z.union([z.literal(10), z.literal(60)]) })
  })
]);
const settingsSchema = z.strictObject({
  bindings: z.array(bindingSchema),
  placement: z.strictObject({}),
  compatibility_date: z.iso.date(),
  compatibility_flags: z.array(z.string()),
  usage_model: z.literal('standard'),
  tags: emptyList,
  tail_consumers: emptyList,
  logpush: z.boolean(),
  observability: z.strictObject({
    enabled: z.boolean(),
    head_sampling_rate: sampleRate,
    redact_query_string: z.boolean(),
    logs: telemetry,
    traces: telemetry,
    issues: z.strictObject({ enabled: z.boolean() }).optional()
  }),
  annotations: z.record(z.string(), z.string()).optional()
});
const stateSchema = z.strictObject({
  settings: settingsSchema,
  subdomain: z.strictObject({ enabled: z.boolean(), previews_enabled: z.boolean() }),
  routes: emptyList,
  domains: emptyList,
  version: z.uuid()
});

export function validateState(input) {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Production metadata is incomplete or unsupported; refusing to change configuration.');
  }
  const state = parsed.data;
  const names = state.settings.bindings.map((binding) => binding.name);
  if (names.length !== bindingNames.length || new Set(names).size !== names.length ||
      bindingNames.some((name) => !names.includes(name))) {
    throw new Error('Production binding names differ from the supported authentication Worker contract.');
  }
  return state;
}

export function createDeploymentConfig(input, accountId) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('A valid Cloudflare account ID is required.');
  const { settings, subdomain } = validateState(input);
  return {
    name: workerName,
    account_id: accountId,
    main: path.join(root, 'worker', 'src', 'index.ts'),
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    workers_dev: subdomain.enabled,
    preview_urls: subdomain.previews_enabled,
    keep_vars: true,
    logpush: settings.logpush,
    observability: settings.observability,
    d1_databases: settings.bindings.filter((binding) => binding.type === 'd1').map((binding) => ({
      binding: binding.name, database_id: binding.database_id
    })),
    ratelimits: settings.bindings.filter((binding) => binding.type === 'ratelimit').map((binding) => ({
      name: binding.name, namespace_id: binding.namespace_id, simple: binding.simple
    }))
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function configurationFingerprint(input) {
  const { version, settings: { annotations, bindings, ...settings }, ...state } = validateState(input);
  return createHash('sha256').update(JSON.stringify(canonical({
    ...state, settings: { ...settings, bindings: [...bindings].sort((a, b) => a.name.localeCompare(b.name)) }
  }))).digest('hex');
}

export function assertUnchanged(before, after, { allowNewVersion = false } = {}) {
  if (configurationFingerprint(before) !== configurationFingerprint(after) ||
      !allowNewVersion && before.version !== after.version) {
    throw new Error('Production configuration or version changed; stop and inspect before proceeding.');
  }
}

export function validateTarget({ accountId, dryRun, metadataFile }, env) {
  const account = accountId ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/.test(account) ||
      env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== account ||
      env.WRANGLER_CI_OVERRIDE_NAME && env.WRANGLER_CI_OVERRIDE_NAME !== workerName) {
    throw new Error('Cloudflare account or Worker target is missing or inconsistent.');
  }
  if (metadataFile && !dryRun) throw new Error('Offline metadata is allowed only with --dry-run.');
  if (!dryRun && (env.WORKERS_CI !== '1' || env.WORKERS_CI_BRANCH !== 'master')) {
    throw new Error('Production deployment is allowed only in Workers Builds on master.');
  }
  if (!metadataFile && !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to read production metadata; credentials are never read from disk.');
  }
  return account;
}

export async function readProductionState(accountId, token, fetchImpl = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const script = `${base}/workers/scripts/${workerName}`;
  async function get(url, label, collectionKey) {
    const envelope = await getPage(url, label);
    if (collectionKey && envelope.result_info) {
      const paginationSchema = z.object({
        page: z.number().int().positive(),
        per_page: z.number().int().positive(),
        count: z.number().int().nonnegative(),
        total_count: z.number().int().nonnegative(),
        total_pages: z.number().int().positive()
      });
      const parsed = paginationSchema.safeParse(envelope.result_info);
      if (!parsed.success) throw new Error(`Cloudflare ${label} pagination is incomplete; refusing deployment.`);
      const info = parsed.data;
      const items = envelope.result?.[collectionKey];
      if (!Array.isArray(items) || info.page !== 1 || info.count !== items.length ||
          info.total_pages !== Math.max(1, Math.ceil(info.total_count / info.per_page))) {
        throw new Error(`Cloudflare ${label} response is incomplete; refusing deployment.`);
      }
      const combined = [...items];
      for (let page = 2; page <= info.total_pages; page++) {
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('page', `${page}`);
        nextUrl.searchParams.set('per_page', `${info.per_page}`);
        const next = await getPage(nextUrl.href, label);
        const nextInfo = paginationSchema.safeParse(next.result_info);
        const nextItems = next.result?.[collectionKey];
        if (!nextInfo.success || nextInfo.data.page !== page ||
            nextInfo.data.per_page !== info.per_page || nextInfo.data.total_pages !== info.total_pages ||
            nextInfo.data.total_count !== info.total_count || !Array.isArray(nextItems) ||
            nextInfo.data.count !== nextItems.length) {
          throw new Error(`Cloudflare ${label} pagination changed or is incomplete; refusing deployment.`);
        }
        combined.push(...nextItems);
      }
      if (combined.length !== info.total_count ||
          new Set(combined.map((item) => item?.id)).size !== combined.length ||
          combined.some((item) => typeof item?.id !== 'string')) {
        throw new Error(`Cloudflare ${label} pagination is incomplete; refusing deployment.`);
      }
      return { ...envelope.result, [collectionKey]: combined };
    }
    if (envelope.result_info?.total_pages > 1 ||
        Array.isArray(envelope.result) && envelope.result_info?.total_count > envelope.result.length) {
      throw new Error(`Cloudflare ${label} response is incomplete; refusing deployment.`);
    }
    return envelope.result;
  }
  async function getPage(url, label) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      throw new Error(`Could not read Cloudflare ${label}; check connectivity and token permissions.`);
    }
    if (!response.ok) throw new Error(`Cloudflare ${label} read failed (HTTP ${response.status}); no deployment was attempted by this read.`);
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`Cloudflare ${label} returned invalid JSON.`);
    }
    if (envelope.success !== true || envelope.result === undefined) {
      throw new Error(`Cloudflare ${label} response is incomplete; refusing deployment.`);
    }
    return envelope;
  }
  const [settings, subdomain, routes, allDomains, deploymentResult] = await Promise.all([
    get(`${script}/settings`, 'settings'),
    get(`${script}/subdomain`, 'subdomain'),
    get(`${script}/routes`, 'routes'),
    get(`${base}/workers/domains`, 'custom domains'),
    get(`${script}/deployments`, 'deployments', 'deployments')
  ]);
  if (!Array.isArray(allDomains) ||
      allDomains.some((domain) => typeof domain?.service !== 'string') ||
      !Array.isArray(deploymentResult?.deployments) ||
      deploymentResult.deployments.some((deployment) => !Number.isFinite(Date.parse(deployment.created_on)))) {
    throw new Error('Cloudflare routing or deployment metadata is incomplete.');
  }
  const latest = [...deploymentResult.deployments].sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on)
  )[0];
  if (latest?.versions?.length !== 1 || latest.versions[0].percentage !== 100) {
    throw new Error('Only a single active production version at 100% is supported.');
  }
  const state = validateState({
    settings, subdomain, routes,
    domains: allDomains.filter((domain) => domain.service === workerName),
    version: latest.versions[0].version_id
  });
  const active = await get(`${script}/versions/${state.version}`, 'active version');
  const runtime = active?.resources?.script_runtime;
  const activeBindings = active?.resources?.bindings;
  if (active.id !== state.version || !runtime || !Array.isArray(activeBindings)) {
    throw new Error('Active production version metadata is incomplete.');
  }
  const parsedBindings = z.array(bindingSchema).safeParse(activeBindings.map((binding) =>
    binding.type === 'd1' ? { ...binding, database_id: binding.id } : binding));
  const parsedRuntime = z.strictObject({
    compatibility_date: z.iso.date(),
    compatibility_flags: z.array(z.string()).optional(),
    usage_model: z.literal('standard')
  }).safeParse(runtime);
  if (!parsedBindings.success || !parsedRuntime.success) {
    throw new Error('Active production version contains unsupported bindings or runtime settings.');
  }
  const activeState = {
    ...state,
    settings: {
      ...state.settings,
      bindings: parsedBindings.data,
      compatibility_date: parsedRuntime.data.compatibility_date,
      compatibility_flags: parsedRuntime.data.compatibility_flags ?? [],
      usage_model: parsedRuntime.data.usage_model
    }
  };
  assertUnchanged(state, activeState);
  return state;
}

export function wranglerArguments(configPath, dryRun) {
  return [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'deploy', '--config', configPath, '--keep-vars', '--strict', '--autoconfig=false',
    ...(dryRun ? ['--dry-run'] : [])
  ];
}

function runWrangler(configPath, dryRun, accountId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, wranglerArguments(configPath, dryRun), {
      cwd: root,
      env: {
        ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Wrangler diagnostics may contain runtime values; never forward its raw output.
    let outputTail = '';
    child.stdout.on('data', (chunk) => {
      outputTail = `${outputTail}${chunk}`.slice(-4096);
    });
    child.stderr.resume();
    child.once('error', () => reject(new Error('Could not start the installed Wrangler executable.')));
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Wrangler ${dryRun ? 'dry-run' : 'deployment'} failed (exit ${code}); raw diagnostics were withheld to protect runtime values.`));
      } else {
        const version = /Current Version ID:\s*([a-f0-9-]{36})/i.exec(outputTail)?.[1];
        if (!dryRun && !version) reject(new Error('Wrangler did not report the uploaded version; production deployment is not verified.'));
        else resolve(version);
      }
    });
  });
}

export async function withTemporaryConfig(config, callback) {
  const directory = await mkdtemp(path.join(root, 'worker', '.deploy-'));
  try {
    const configPath = path.join(directory, 'wrangler.json');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return await callback(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'metadata-file': { type: 'string' }
    },
    strict: true
  });
  const dryRun = values['dry-run'];
  const metadataFile = values['metadata-file'];
  const accountId = validateTarget({ accountId: values['account-id'], dryRun, metadataFile }, process.env);
  const readState = metadataFile
    ? async () => validateState(JSON.parse(await readFile(metadataFile, 'utf8')))
    : () => readProductionState(accountId, process.env.CLOUDFLARE_API_TOKEN);
  const before = await readState();
  const config = createDeploymentConfig(before, accountId);
  console.log(`Validated production metadata for ${workerName}; no values or credentials will be logged.`);
  await withTemporaryConfig(config, async (configPath) => {
    await runWrangler(configPath, true, accountId);
    console.log('Explicit authentication Worker dry-run passed; no Astro auto-configuration was used.');
    if (!dryRun) {
      assertUnchanged(before, await readState());
      const deployedVersion = await runWrangler(configPath, false, accountId);
      const after = await readState();
      assertUnchanged(before, after, { allowNewVersion: true });
      if (before.version === after.version || after.version !== deployedVersion) {
        throw new Error('Active production version does not match the new Wrangler deployment; inspect before proceeding.');
      }
      console.log(`Production version ${after.version} is active; supported runtime configuration is unchanged.`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Production deployment failed.');
    process.exitCode = 1;
  });
}
