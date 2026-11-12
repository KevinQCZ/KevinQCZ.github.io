interface Env {
  DB: D1Database;
  AUTH_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  SITE_ORIGIN: string;
  API_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ADMIN_GITHUB_IDS: string;
  CSRF_SECRET: string;
}

interface Config {
  site: string;
  api: string;
  clientId: string;
  clientSecret: string;
  allowedIds: Set<string>;
  csrfSecret: string;
}

interface Session {
  id: string;
  github_user_id: string;
  github_login: string;
  session_hash: string;
  expires_at: number;
  created_at: number;
  last_used_at: number;
}

interface AuthContext {
  session: Session;
  token: string;
}

interface ArticleDraft {
  sourceFormat: 'md' | 'mdx';
  title: string;
  description: string;
  publishedAt: string;
  categories: string[];
  tags: string[];
  coverUrl: string | null;
  body: string;
  expectedRevision: number | null;
}

interface StoredArticleDraft extends Omit<ArticleDraft, 'expectedRevision' | 'coverUrl'> {
  permalink: string;
  coverUrl: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

const SESSION_COOKIE = '__Host-admin_session';
const TRANSACTION_COOKIE = '__Host-oauth_transaction';
const SESSION_SECONDS = 24 * 60 * 60;
const TRANSACTION_SECONDS = 10 * 60;
const MAX_DRAFT_REQUEST_BYTES = 400 * 1024;
const MAX_DRAFT_BODY_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function origin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error('Invalid origin configuration');
  }
  return parsed.origin;
}

function config(env: Env): Config {
  const site = origin(env.SITE_ORIGIN);
  const api = origin(env.API_ORIGIN);
  const ids = typeof env.ADMIN_GITHUB_IDS === 'string' ? env.ADMIN_GITHUB_IDS.split(',') : [];
  if (
    site === api || !env.GITHUB_CLIENT_ID?.trim() || !env.GITHUB_CLIENT_SECRET?.trim() ||
    !env.CSRF_SECRET || encoder.encode(env.CSRF_SECRET).length < 32 ||
    !ids.length || ids.some((id) => !/^[1-9]\d*$/.test(id))
  ) throw new Error('Invalid authentication configuration');
  return {
    site, api, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    allowedIds: new Set(ids), csrfSecret: env.CSRF_SECRET
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function csrf(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(token))));
}

function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function headers(request: Request, cfg: Config): Headers {
  const result = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Vary': 'Origin'
  });
  if (request.headers.get('Origin') === cfg.site) {
    result.set('Access-Control-Allow-Origin', cfg.site);
    result.set('Access-Control-Allow-Credentials', 'true');
  }
  return result;
}

function json(request: Request, cfg: Config, status: number, body: object): Response {
  const h = headers(request, cfg);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: h });
}

function error(request: Request, cfg: Config, status: number, code: string): Response {
  return json(request, cfg, status, { error: code });
}

function redirect(request: Request, cfg: Config, location: string, cookies: string[]): Response {
  const h = headers(request, cfg);
  h.set('Location', location);
  for (const value of cookies) h.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers: h });
}

async function limit(request: Request, binding: RateLimit, endpoint: string): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !binding) throw new Error('Rate limiting unavailable');
  return (await binding.limit({ key: `${endpoint}:${ip}` })).success;
}

export async function requireAuthentication(
  request: Request,
  env: Env,
  cfg: Config
): Promise<AuthContext | Response> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return error(request, cfg, 401, 'unauthorized');
  const now = Date.now();
  const record = await env.DB.prepare(
    `UPDATE admin_sessions SET last_used_at = ?
     WHERE session_hash = ? AND expires_at > ?
     RETURNING id, github_user_id, github_login, session_hash, expires_at, created_at, last_used_at`
  ).bind(now, await hash(token), now).first<Session>();
  if (!record || !record.github_login) return error(request, cfg, 401, 'unauthorized');
  return { session: record, token };
}

export function requireAdmin(
  request: Request,
  auth: AuthContext,
  cfg: Config
): Response | null {
  return cfg.allowedIds.has(auth.session.github_user_id)
    ? null
    : error(request, cfg, 403, 'forbidden');
}

export async function requireCsrfProtection(
  request: Request,
  auth: AuthContext,
  cfg: Config
): Promise<Response | null> {
  const supplied = request.headers.get('X-CSRF-Token') || '';
  const expected = await csrf(auth.token, cfg.csrfSecret);
  const suppliedBytes = encoder.encode(supplied);
  const expectedBytes = encoder.encode(expected);
  let difference = suppliedBytes.length ^ expectedBytes.length;
  for (let i = 0; i < Math.max(suppliedBytes.length, expectedBytes.length); i += 1) {
    difference |= (suppliedBytes[i] || 0) ^ (expectedBytes[i] || 0);
  }
  return validUnsafeRequest(request, cfg) && difference === 0
    ? null
    : error(request, cfg, 403, 'forbidden');
}

async function audit(env: Env, action: string, result: string, userId: string | null = null): Promise<void> {
  await env.DB.prepare('INSERT INTO audit_logs (id, github_user_id, action, created_at, result) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, action, Date.now(), result).run();
}

async function providerJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('Provider response too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

class PayloadTooLargeError extends Error {}

async function requestJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DRAFT_REQUEST_BYTES) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) throw new SyntaxError('Missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DRAFT_REQUEST_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validLabels(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((label) => typeof label === 'string' && label.trim().length > 0 && label.length <= 80) &&
    new Set(value).size === value.length;
}

function validCoverUrl(value: unknown): value is string | null {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseArticleDraft(value: unknown): ArticleDraft | null {
  if (!isRecord(value) || !['md', 'mdx'].includes(String(value.sourceFormat)) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 ||
      typeof value.description !== 'string' || !value.description.trim() || value.description.length > 500 ||
      !validDate(value.publishedAt) || !validLabels(value.categories, 20) ||
      !validLabels(value.tags, 40) || !validCoverUrl(value.coverUrl) ||
      typeof value.body !== 'string' || encoder.encode(value.body).length > MAX_DRAFT_BODY_BYTES ||
      !(value.expectedRevision === null ||
        (typeof value.expectedRevision === 'number' && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0))) {
    return null;
  }
  return {
    sourceFormat: value.sourceFormat as ArticleDraft['sourceFormat'],
    title: value.title,
    description: value.description,
    publishedAt: value.publishedAt,
    categories: value.categories,
    tags: value.tags,
    coverUrl: value.coverUrl === '' ? null : value.coverUrl,
    body: value.body,
    expectedRevision: value.expectedRevision
  };
}

function validArticlePermalink(value: string | null): value is string {
  return Boolean(value && value.length <= 200 &&
    /^\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..'));
}

function storedDraft(row: {
  permalink: string;
  source_format: 'md' | 'mdx';
  title: string;
  description: string;
  published_at: string;
  categories_json: string;
  tags_json: string;
  cover_url: string | null;
  body: string;
  revision: number;
  created_at: number;
  updated_at: number;
}): StoredArticleDraft {
  return {
    permalink: row.permalink,
    sourceFormat: row.source_format,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at,
    categories: JSON.parse(row.categories_json) as string[],
    tags: JSON.parse(row.tags_json) as string[],
    coverUrl: row.cover_url,
    body: row.body,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function start(request: Request, env: Env, cfg: Config): Promise<Response> {
  if (!await limit(request, env.AUTH_RATE_LIMITER, 'start')) return error(request, cfg, 429, 'rate_limited');
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_transactions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO oauth_transactions (state_hash, binding_hash, verifier, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hash(state), await hash(browser), verifier, now + TRANSACTION_SECONDS * 1000)
  ]);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${cfg.api}/auth/github/callback`,
    state,
    code_challenge: await hash(verifier),
    code_challenge_method: 'S256'
  }).toString();
  return redirect(request, cfg, url.href, [cookie(TRANSACTION_COOKIE, browser, TRANSACTION_SECONDS)]);
}

async function callback(request: Request, env: Env, cfg: Config): Promise<Response> {
  if (!await limit(request, env.AUTH_RATE_LIMITER, 'callback')) return error(request, cfg, 429, 'rate_limited');
  const params = new URL(request.url).searchParams;
  const browser = cookieValue(request, TRANSACTION_COOKIE);
  const state = params.get('state');
  const code = params.get('code');
  if (
    params.getAll('state').length !== 1 || params.getAll('code').length !== 1 ||
    params.has('error') || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !code || code.length > 2048 || !browser
  ) return error(request, cfg, 400, 'invalid_callback');

  const transaction = await env.DB.prepare(
    'DELETE FROM oauth_transactions WHERE state_hash = ? AND binding_hash = ? AND expires_at > ? RETURNING verifier'
  ).bind(await hash(state), await hash(browser), Date.now()).first<{ verifier: string }>();
  if (!transaction) return error(request, cfg, 400, 'invalid_callback');

  const exchange = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
      redirect_uri: `${cfg.api}/auth/github/callback`, code_verifier: transaction.verifier
    })
  });
  if (!exchange.ok) return error(request, cfg, 502, 'provider_unavailable');
  const tokenResponse = await providerJson(exchange);
  if (!tokenResponse || typeof tokenResponse !== 'object' ||
      !('access_token' in tokenResponse) || typeof tokenResponse.access_token !== 'string' ||
      !tokenResponse.access_token) return error(request, cfg, 502, 'provider_unavailable');
  const identity = await fetch('https://api.github.com/user', {
    redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenResponse.access_token}`, 'User-Agent': 'personal-site-auth' }
  });
  if (!identity.ok) return error(request, cfg, 502, 'provider_unavailable');
  const user = await providerJson(identity);
  if (!user || typeof user !== 'object' || !('id' in user) ||
      typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0 ||
      !('login' in user) || typeof user.login !== 'string' ||
      user.login.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(user.login)) {
    return error(request, cfg, 502, 'invalid_provider_identity');
  }
  const userId = String(user.id);
  const login = user.login;
  if (!cfg.allowedIds.has(userId)) {
    await audit(env, 'login', 'denied', userId);
    return error(request, cfg, 403, 'forbidden');
  }
  const oldToken = cookieValue(request, SESSION_COOKIE);
  const newToken = randomToken();
  const now = Date.now();
  const statements = [];
  if (oldToken) statements.push(env.DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?').bind(await hash(oldToken)));
  statements.push(
    env.DB.prepare('INSERT INTO admin_sessions (id, github_user_id, github_login, session_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, login, await hash(newToken), now + SESSION_SECONDS * 1000, now, now),
    env.DB.prepare('INSERT INTO audit_logs (id, github_user_id, action, created_at, result) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, 'login', now, 'success')
  );
  await env.DB.batch(statements);
  return redirect(request, cfg, `${cfg.site}/admin/`, [
    cookie(TRANSACTION_COOKIE, '', 0), cookie(SESSION_COOKIE, newToken, SESSION_SECONDS)
  ]);
}

function validUnsafeRequest(request: Request, cfg: Config): boolean {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return request.headers.get('Origin') === cfg.site &&
    (!fetchSite || fetchSite === 'same-site' || fetchSite === 'same-origin') &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '');
}

async function handle(request: Request, env: Env, cfg: Config): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (request.headers.get('Origin') !== cfg.site || !['GET', 'POST', 'PUT'].includes(method || '') ||
        requestedHeaders.some((h) => !['content-type', 'x-csrf-token'].includes(h))) {
      return error(request, cfg, 403, 'forbidden');
    }
    const h = headers(request, cfg);
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    h.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    return new Response(null, { status: 204, headers: h });
  }
  if (path === '/auth/github' && request.method === 'GET') return start(request, env, cfg);
  if (path === '/auth/github/callback' && request.method === 'GET') return callback(request, env, cfg);
  if (
    path === '/api/me' || path === '/api/logout' ||
    path === '/api/admin' || path.startsWith('/api/admin/')
  ) {
    const auth = await requireAuthentication(request, env, cfg);
    if (auth instanceof Response) return auth;
    const adminError = requireAdmin(request, auth, cfg);
    if (adminError) return adminError;
    if (path === '/api/me' && request.method === 'GET') {
      return json(request, cfg, 200, {
        authenticated: true,
        user: {
          githubId: auth.session.github_user_id,
          githubLogin: auth.session.github_login,
          role: 'ADMIN'
        },
        csrfToken: await csrf(auth.token, cfg.csrfSecret)
      });
    }
    if (path === '/api/admin/drafts' && request.method === 'GET') {
      const permalink = url.searchParams.getAll('permalink');
      if (permalink.length !== 1 || !validArticlePermalink(permalink[0])) {
        return error(request, cfg, 400, 'invalid_draft');
      }
      const row = await env.DB.prepare(
        `SELECT permalink, source_format, title, description, published_at,
                categories_json, tags_json, cover_url, body, revision, created_at, updated_at
         FROM article_drafts WHERE permalink = ?`
      ).bind(permalink[0]).first<{
        permalink: string; source_format: 'md' | 'mdx'; title: string; description: string;
        published_at: string; categories_json: string; tags_json: string; cover_url: string | null;
        body: string; revision: number; created_at: number; updated_at: number;
      }>();
      return row
        ? json(request, cfg, 200, { draft: storedDraft(row) })
        : error(request, cfg, 404, 'not_found');
    }
    if (path === '/api/admin/drafts' && request.method === 'PUT') {
      const csrfError = await requireCsrfProtection(request, auth, cfg);
      if (csrfError) return csrfError;
      if (url.searchParams.getAll('permalink').length !== 1 ||
          !validArticlePermalink(url.searchParams.get('permalink'))) {
        return error(request, cfg, 400, 'invalid_draft');
      }
      if (!await limit(request, env.WRITE_RATE_LIMITER, 'draft-save')) {
        return error(request, cfg, 429, 'rate_limited');
      }
      let payload: unknown;
      try {
        payload = await requestJson(request);
      } catch (cause) {
        return cause instanceof PayloadTooLargeError
          ? error(request, cfg, 413, 'payload_too_large')
          : error(request, cfg, 400, 'invalid_json');
      }
      const draft = parseArticleDraft(payload);
      if (!draft) return error(request, cfg, 400, 'invalid_draft');
      const permalink = url.searchParams.get('permalink')!;
      const now = Date.now();
      const values = [
        draft.sourceFormat, draft.title, draft.description, draft.publishedAt,
        JSON.stringify(draft.categories), JSON.stringify(draft.tags), draft.coverUrl, draft.body
      ];
      const row = draft.expectedRevision === null
        ? await env.DB.prepare(
          `INSERT INTO article_drafts
           (permalink, source_format, title, description, published_at, categories_json, tags_json,
            cover_url, body, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(permalink) DO NOTHING
           RETURNING permalink, source_format, title, description, published_at,
                     categories_json, tags_json, cover_url, body, revision, created_at, updated_at`
        ).bind(permalink, ...values, now, now).first<{
          permalink: string; source_format: 'md' | 'mdx'; title: string; description: string;
          published_at: string; categories_json: string; tags_json: string; cover_url: string | null;
          body: string; revision: number; created_at: number; updated_at: number;
        }>()
        : await env.DB.prepare(
          `UPDATE article_drafts
           SET source_format = ?, title = ?, description = ?, published_at = ?, categories_json = ?,
               tags_json = ?, cover_url = ?, body = ?, revision = revision + 1, updated_at = ?
           WHERE permalink = ? AND revision = ?
           RETURNING permalink, source_format, title, description, published_at,
                     categories_json, tags_json, cover_url, body, revision, created_at, updated_at`
        ).bind(...values, now, permalink, draft.expectedRevision).first<{
          permalink: string; source_format: 'md' | 'mdx'; title: string; description: string;
          published_at: string; categories_json: string; tags_json: string; cover_url: string | null;
          body: string; revision: number; created_at: number; updated_at: number;
        }>();
      return row
        ? json(request, cfg, 200, { draft: storedDraft(row) })
        : error(request, cfg, 409, 'revision_conflict');
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const csrfError = await requireCsrfProtection(request, auth, cfg);
      if (csrfError) return csrfError;
      if (!await limit(request, env.WRITE_RATE_LIMITER, 'logout')) return error(request, cfg, 429, 'rate_limited');
      const [deleted] = await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE id = ? AND session_hash = ? AND expires_at > ?')
          .bind(auth.session.id, auth.session.session_hash, Date.now()),
        env.DB.prepare('INSERT INTO audit_logs (id, github_user_id, action, created_at, result) SELECT ?, ?, ?, ?, ? WHERE changes() = 1')
          .bind(crypto.randomUUID(), auth.session.github_user_id, 'logout', Date.now(), 'success')
      ]);
      if (deleted.meta.changes !== 1) return error(request, cfg, 401, 'unauthorized');
      const response = json(request, cfg, 200, { ok: true });
      response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
      return response;
    }
    return error(request, cfg, 404, 'not_found');
  }
  return error(request, cfg, 404, 'not_found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const response = await handle(request, env, config(env));
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch {
      console.error(`Authentication service unavailable (${requestId})`);
      return new Response(JSON.stringify({ error: 'service_unavailable' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
          'Vary': 'Origin',
          'X-Request-ID': requestId
        }
      });
    }
  }
} satisfies ExportedHandler<Env>;
