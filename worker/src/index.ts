import { articleMetadataSchema } from '../../src/lib/article-schema';
import {
  getPublishedArticle,
  getPullRequest,
  GitHubSourceError,
  listPublishedArticles,
  publishArticleDraft,
  publishedArticleConflicts,
  type ArticlePublicationInput,
  validArticlePath,
  type GitHubAppConfig,
  type PublishedArticle
} from './github';

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
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

interface Config {
  site: string;
  api: string;
  clientId: string;
  clientSecret: string;
  allowedIds: Set<string>;
  csrfSecret: string;
  githubApp: GitHubAppConfig | null;
}

type CallbackStage =
  | 'rate_limit'
  | 'validation'
  | 'transaction'
  | 'token_exchange_request'
  | 'token_exchange_response'
  | 'identity'
  | 'authorization'
  | 'handoff'
  | 'redirect';

interface RequestDiagnostics {
  callbackStage?: CallbackStage;
  tokenRequestFailure?: 'redirect' | 'timeout' | 'dns' | 'tls' | 'connection' | 'other';
  tokenResponseStatus?: number;
  tokenResponseError?: 'bad_verification_code' | 'incorrect_client_credentials' | 'redirect_uri_mismatch' |
    'access_denied' | 'unauthorized_client' | 'other';
  tokenRedirect?: {
    status: number;
    host: 'github.com' | 'www.github.com' | 'api.github.com' | 'other' | 'invalid';
    samePath: boolean;
    https: boolean;
  };
}

function classifyTokenRequestFailure(error: unknown): NonNullable<RequestDiagnostics['tokenRequestFailure']> {
  const message = error instanceof Error ? error.message : '';
  if (/redirect/i.test(message)) return 'redirect';
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout';
  if (/dns|resolve|enotfound/i.test(message)) return 'dns';
  if (/tls|ssl|certificate/i.test(message)) return 'tls';
  if (/connect|network|socket|fetch failed/i.test(message)) return 'connection';
  return 'other';
}

function classifyTokenRedirect(response: Response): NonNullable<RequestDiagnostics['tokenRedirect']> {
  const result: NonNullable<RequestDiagnostics['tokenRedirect']> = {
    status: response.status, host: 'invalid', samePath: false, https: false
  };
  const location = response.headers.get('Location');
  if (!location) return result;
  try {
    const url = new URL(location, 'https://github.com/login/oauth/access_token');
    result.host = url.host === 'github.com' || url.host === 'www.github.com' || url.host === 'api.github.com'
      ? url.host : 'other';
    result.samePath = url.pathname === '/login/oauth/access_token';
    result.https = url.protocol === 'https:';
  } catch {
    return result;
  }
  return result;
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

interface ManagedDraftInput extends ArticleDraft {
  permalink: string;
  articleId: string | null;
}

interface StoredArticleDraft extends Omit<ArticleDraft, 'expectedRevision' | 'coverUrl'> {
  id: string;
  articlePath: string | null;
  baseSha: string | null;
  status: 'DRAFT' | 'PENDING_PUBLICATION' | 'PUBLISHED' | 'UNPUBLISHED';
  permalink: string;
  coverUrl: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  publicationState: 'NOT_SUBMITTED' | 'OPEN' | 'CLOSED' | 'MERGED';
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  submittedRevision: number | null;
}

interface DraftRow {
  id: string;
  article_path: string | null;
  base_sha: string | null;
  status: 'DRAFT' | 'PENDING_PUBLICATION' | 'PUBLISHED' | 'UNPUBLISHED';
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
  created_by: string | null;
  updated_by: string | null;
  publication_branch: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  publication_state: 'NOT_SUBMITTED' | 'OPEN' | 'CLOSED' | 'MERGED';
  published_sha: string | null;
  submitted_revision: number | null;
  publication_lock: string | null;
  publication_lock_expires_at: number | null;
}

const DRAFT_COLUMNS = `id, article_path, base_sha, status, permalink, source_format, title,
  description, published_at, categories_json, tags_json, cover_url, body, revision,
  created_at, updated_at, created_by, updated_by, publication_branch,
  pull_request_number, pull_request_url, publication_state, published_sha,
  submitted_revision, publication_lock, publication_lock_expires_at`;

const TRANSACTION_COOKIE = '__Host-oauth_transaction';
const SESSION_SECONDS = 60 * 60;
const TRANSACTION_SECONDS = 10 * 60;
const HANDOFF_SECONDS = 2 * 60;
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
  const githubAppValues = [env.GITHUB_APP_ID, env.GITHUB_APP_INSTALLATION_ID, env.GITHUB_APP_PRIVATE_KEY];
  const hasGitHubAppConfig = githubAppValues.some((value) => Boolean(value?.trim()));
  if (
    site === api || !env.GITHUB_CLIENT_ID?.trim() || !env.GITHUB_CLIENT_SECRET?.trim() ||
    !env.CSRF_SECRET || encoder.encode(env.CSRF_SECRET).length < 32 ||
    !ids.length || ids.some((id) => !/^[1-9]\d*$/.test(id)) ||
    (hasGitHubAppConfig && githubAppValues.some((value) => !value?.trim()))
  ) throw new Error('Invalid authentication configuration');
  return {
    site, api, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    allowedIds: new Set(ids), csrfSecret: env.CSRF_SECRET,
    githubApp: hasGitHubAppConfig ? {
      appId: env.GITHUB_APP_ID!,
      installationId: env.GITHUB_APP_INSTALLATION_ID!,
      privateKey: env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n')
    } : null
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
  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return error(request, cfg, 401, 'unauthorized');
  const token = match[1];
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

async function auditDraft(
  env: Env,
  userId: string,
  action: string,
  draftId: string,
  result = 'success'
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs
     (id, github_user_id, action, created_at, result, resource_type, resource_id)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`
  ).bind(crypto.randomUUID(), userId, action, Date.now(), result, draftId).run();
}

function draftSummary(row: DraftRow) {
  const { body: _body, ...draft } = storedDraft(row);
  return draft;
}

function sourceUnavailable(request: Request, cfg: Config): Response {
  return error(request, cfg, 503, 'github_source_unavailable');
}

async function adminArticleList(request: Request, env: Env, cfg: Config): Promise<Response> {
  let articles: Awaited<ReturnType<typeof listPublishedArticles>> = [];
  let publishedSourceError: 'not_configured' | 'unavailable' | null =
    cfg.githubApp ? null : 'not_configured';
  if (cfg.githubApp) {
    try {
      articles = await listPublishedArticles(cfg.githubApp);
    } catch {
      publishedSourceError = 'unavailable';
    }
  }
  if (cfg.githubApp && publishedSourceError === null) {
    const pending = await env.DB.prepare(
      `SELECT id, article_path, revision, submitted_revision, pull_request_number
       FROM article_drafts WHERE status = 'PENDING_PUBLICATION'
       AND pull_request_number IS NOT NULL ORDER BY updated_at DESC LIMIT 20`
    ).all<Pick<DraftRow, 'id' | 'article_path' | 'revision' | 'submitted_revision' | 'pull_request_number'>>();
    for (const draft of pending.results) {
      try {
        const pullRequest = await getPullRequest(cfg.githubApp, draft.pull_request_number!);
        if (pullRequest.state === 'MERGED') {
          const currentFile = articles.find((article) => article.articlePath === draft.article_path);
          if (!currentFile) continue;
          const isLatestRevision = draft.revision === draft.submitted_revision;
          await env.DB.prepare(
            `UPDATE article_drafts SET status = ?, publication_state = 'MERGED',
             publication_branch = CASE WHEN ? = 1 THEN publication_branch ELSE NULL END,
             base_sha = ?, published_sha = ?, publication_lock = NULL,
             publication_lock_expires_at = NULL
             WHERE id = ? AND status = 'PENDING_PUBLICATION'`
          ).bind(isLatestRevision ? 'PUBLISHED' : 'DRAFT', isLatestRevision ? 1 : 0,
            currentFile.sha, pullRequest.mergeCommitSha, draft.id).run();
        } else {
          await env.DB.prepare(
            `UPDATE article_drafts SET publication_state = ?
             WHERE id = ? AND status = 'PENDING_PUBLICATION'`
          ).bind(pullRequest.state, draft.id).run();
        }
      } catch {
        publishedSourceError = 'unavailable';
      }
    }
  }
  const drafts = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts
     WHERE status IN ('DRAFT', 'PENDING_PUBLICATION') ORDER BY updated_at DESC LIMIT 200`
  ).all<DraftRow>();
  return json(request, cfg, 200, {
    articles,
    drafts: drafts.results.map(draftSummary),
    publishedSourceAvailable: publishedSourceError === null,
    publishedSourceError
  });
}

async function adminArticleDetail(
  request: Request,
  env: Env,
  cfg: Config,
  id: string,
  userId: string
): Promise<Response> {
  if (/^d_[a-f0-9-]{32,36}$/i.test(id)) {
    const row = await env.DB.prepare(
      `SELECT ${DRAFT_COLUMNS} FROM article_drafts
       WHERE id = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')`
    ).bind(id.slice(2)).first<DraftRow>();
    if (!row) return error(request, cfg, 404, 'not_found');
    await auditDraft(env, userId, 'draft.preview', row.id);
    return json(request, cfg, 200, { draft: storedDraft(row) });
  }
  if (!/^a_[A-Za-z0-9_-]{22}$/.test(id)) return error(request, cfg, 404, 'not_found');
  if (!cfg.githubApp) return sourceUnavailable(request, cfg);
  let article: PublishedArticle | null;
  try {
    article = await getPublishedArticle(cfg.githubApp, id);
  } catch {
    return sourceUnavailable(request, cfg);
  }
  if (!article) return error(request, cfg, 404, 'not_found');
  const row = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts
     WHERE status IN ('DRAFT', 'PENDING_PUBLICATION')
       AND (article_path = ? OR permalink = ?)
     ORDER BY CASE WHEN article_path = ? THEN 0 ELSE 1 END LIMIT 1`
  ).bind(article.articlePath, article.permalink, article.articlePath).first<DraftRow>();
  if (row) await auditDraft(env, userId, 'draft.preview', row.id);
  return json(request, cfg, 200, {
    article,
    draft: row ? storedDraft(row) : null
  });
}

async function createManagedDraft(
  request: Request,
  env: Env,
  cfg: Config,
  userId: string,
  payload: unknown
): Promise<Response> {
  if (!cfg.githubApp) return sourceUnavailable(request, cfg);
  const input = parseManagedDraft(payload);
  if (!input || input.expectedRevision !== null) return error(request, cfg, 400, 'invalid_draft');

  let articlePath: string;
  let baseSha: string | null = null;
  let sourceFormat: ArticleDraft['sourceFormat'] = input.sourceFormat;
  if (input.articleId) {
    let published: PublishedArticle | null;
    try {
      published = await getPublishedArticle(cfg.githubApp, input.articleId);
    } catch {
      return sourceUnavailable(request, cfg);
    }
    if (!published) return error(request, cfg, 404, 'not_found');
    if (published.permalink !== input.permalink || published.sourceFormat !== input.sourceFormat) {
      return error(request, cfg, 400, 'invalid_draft');
    }
    articlePath = published.articlePath;
    baseSha = published.sha;
    sourceFormat = published.sourceFormat;
  } else {
    const slug = input.permalink.split('/').at(-1)!;
    articlePath = `src/content/articles/${slug}.${sourceFormat}`;
    if (!validArticlePath(articlePath)) return error(request, cfg, 400, 'invalid_article_path');
    try {
      const conflicts = await publishedArticleConflicts(cfg.githubApp, input.permalink, articlePath);
      if (conflicts.permalinkExists || conflicts.pathExists) {
        return error(request, cfg, 409, 'article_conflict');
      }
    } catch {
      return sourceUnavailable(request, cfg);
    }
  }

  const existing = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts
     WHERE permalink = ? OR article_path = ? LIMIT 1`
  ).bind(input.permalink, articlePath).first<DraftRow>();
  if (existing) {
    if (existing.status !== 'PUBLISHED' || !input.articleId) return error(request, cfg, 409, 'draft_exists');
    const [reset] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE article_drafts SET article_path = ?, base_sha = ?, status = 'DRAFT',
         source_format = ?, title = ?, description = ?, published_at = ?, categories_json = ?,
         tags_json = ?, cover_url = ?, body = ?, revision = revision + 1, updated_at = ?,
         updated_by = ?, publication_branch = NULL, pull_request_number = NULL,
         pull_request_url = NULL, publication_state = 'NOT_SUBMITTED', published_sha = NULL,
         submitted_revision = NULL
         WHERE id = ? AND status = 'PUBLISHED'`
      ).bind(articlePath, baseSha, sourceFormat, input.title, input.description, input.publishedAt,
        JSON.stringify(input.categories), JSON.stringify(input.tags), input.coverUrl, input.body,
        Date.now(), userId, existing.id),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, github_user_id, action, created_at, result, resource_type, resource_id)
         SELECT ?, ?, 'draft.create', ?, 'success', 'draft', ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), userId, Date.now(), existing.id)
    ]);
    if (reset.meta.changes !== 1) return error(request, cfg, 409, 'draft_exists');
    const row = await env.DB.prepare(
      `SELECT ${DRAFT_COLUMNS} FROM article_drafts WHERE id = ?`
    ).bind(existing.id).first<DraftRow>();
    if (!row) return error(request, cfg, 503, 'draft_save_failed');
    return json(request, cfg, 201, { draft: storedDraft(row) });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO article_drafts
       (id, article_path, base_sha, status, permalink, source_format, title, description,
        published_at, categories_json, tags_json, cover_url, body, revision, created_at,
        updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(permalink) DO NOTHING`
    ).bind(
      id, articlePath, baseSha, input.permalink, sourceFormat, input.title, input.description,
      input.publishedAt, JSON.stringify(input.categories), JSON.stringify(input.tags),
      input.coverUrl, input.body, now, now, userId, userId
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id)
       SELECT ?, ?, 'draft.create', ?, 'success', 'draft', ? WHERE changes() = 1`
    ).bind(crypto.randomUUID(), userId, now, id)
  ]);
  if (inserted.meta.changes !== 1) return error(request, cfg, 409, 'draft_exists');
  const row = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts WHERE id = ?`
  ).bind(id).first<DraftRow>();
  if (!row) return error(request, cfg, 503, 'draft_save_failed');
  return json(request, cfg, 201, { draft: storedDraft(row) });
}

async function updateManagedDraft(
  request: Request,
  env: Env,
  cfg: Config,
  userId: string,
  id: string,
  payload: unknown
): Promise<Response> {
  const input = parseManagedDraft(payload);
  if (!input || !input.expectedRevision || input.articleId !== null) {
    return error(request, cfg, 400, 'invalid_draft');
  }
  const existing = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts
     WHERE id = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')`
  ).bind(id).first<DraftRow>();
  if (!existing) return error(request, cfg, 404, 'not_found');
  if (input.permalink !== existing.permalink || input.sourceFormat !== existing.source_format) {
    return error(request, cfg, 400, 'invalid_draft');
  }
  const now = Date.now();
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE article_drafts
       SET title = ?, description = ?, published_at = ?, categories_json = ?, tags_json = ?,
           cover_url = ?, body = ?, revision = revision + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND revision = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')
         AND (publication_lock IS NULL OR publication_lock_expires_at <= ?)`
    ).bind(
      input.title, input.description, input.publishedAt, JSON.stringify(input.categories),
      JSON.stringify(input.tags), input.coverUrl, input.body, now, userId, id, input.expectedRevision, now
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id)
       SELECT ?, ?, 'draft.update', ?, 'success', 'draft', ? WHERE changes() = 1`
    ).bind(crypto.randomUUID(), userId, now, id)
  ]);
  if (updated.meta.changes !== 1) {
    const current = await env.DB.prepare('SELECT id FROM article_drafts WHERE id = ?')
      .bind(id).first<{ id: string }>();
    return current
      ? error(request, cfg, 409, 'revision_conflict')
      : error(request, cfg, 404, 'not_found');
  }
  const row = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts WHERE id = ?`
  ).bind(id).first<DraftRow>();
  if (!row) return error(request, cfg, 503, 'draft_save_failed');
  return json(request, cfg, 200, { draft: storedDraft(row) });
}

function publicationBranch(draftId: string, revision: number): string {
  return `blog/draft-${draftId.slice(2).replaceAll('-', '')}-r${revision}`;
}

async function publishManagedDraft(
  request: Request,
  env: Env,
  cfg: Config,
  userId: string,
  id: string,
  payload: unknown
): Promise<Response> {
  if (!cfg.githubApp) return sourceUnavailable(request, cfg);
  if (!isRecord(payload) || typeof payload.expectedRevision !== 'number' ||
      !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return error(request, cfg, 400, 'invalid_draft');
  }
  const row = await env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM article_drafts
     WHERE id = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')`
  ).bind(id).first<DraftRow>();
  if (!row) return error(request, cfg, 404, 'not_found');
  if (row.revision !== payload.expectedRevision) return error(request, cfg, 409, 'revision_conflict');
  if (!row.article_path || !validArticlePath(row.article_path) ||
      !row.article_path.endsWith(`.${row.source_format}`)) {
    return error(request, cfg, 400, 'invalid_article_path');
  }

  const trackedBranch = row.publication_state === 'MERGED' ? null : row.publication_branch;
  const branch = trackedBranch ?? publicationBranch(`d_${row.id}`, row.revision);
  if (!/^blog\/draft-[a-f0-9]{32}-r[1-9]\d*$/i.test(branch)) {
    return error(request, cfg, 409, 'invalid_publication_branch');
  }
  const lock = crypto.randomUUID();
  const now = Date.now();
  const [acquired] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE article_drafts SET publication_lock = ?, publication_lock_expires_at = ?,
       publication_branch = ?
       WHERE id = ? AND revision = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')
         AND (publication_lock IS NULL OR publication_lock_expires_at <= ?)`
    ).bind(lock, now + 5 * 60 * 1000, branch, id, row.revision, now)
  ]);
  if (acquired.meta.changes !== 1) return error(request, cfg, 409, 'publication_in_progress');

  try {
    const article: ArticlePublicationInput = {
      draftId: `d_${row.id}`,
      revision: row.revision,
      articlePath: row.article_path,
      sourceFormat: row.source_format,
      baseSha: row.base_sha,
      title: row.title,
      description: row.description,
      publishedAt: row.published_at,
      permalink: row.permalink,
      categories: JSON.parse(row.categories_json) as string[],
      tags: JSON.parse(row.tags_json) as string[],
      coverUrl: row.cover_url,
      body: row.body
    };
    const result = await publishArticleDraft(
      cfg.githubApp,
      article,
      trackedBranch,
      row.publication_state === 'OPEN' || row.publication_state === 'CLOSED'
        ? row.pull_request_number
        : null
    );
    const [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE article_drafts SET status = 'PENDING_PUBLICATION',
         publication_state = 'OPEN', publication_branch = ?, pull_request_number = ?,
         pull_request_url = ?, submitted_revision = ?, published_sha = NULL,
         publication_lock = NULL, publication_lock_expires_at = NULL
         WHERE id = ? AND revision = ? AND publication_lock = ?`
      ).bind(result.branch, result.pullRequest.number, result.pullRequest.url,
        row.revision, id, row.revision, lock),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, github_user_id, action, created_at, result, resource_type, resource_id)
         SELECT ?, ?, 'draft.publish', ?, 'success', 'draft', ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), userId, Date.now(), id)
    ]);
    if (updated.meta.changes !== 1) return error(request, cfg, 409, 'revision_conflict');
    const saved = await env.DB.prepare(
      `SELECT ${DRAFT_COLUMNS} FROM article_drafts WHERE id = ?`
    ).bind(id).first<DraftRow>();
    if (!saved) return error(request, cfg, 503, 'draft_save_failed');
    return json(request, cfg, 200, {
      draft: storedDraft(saved),
      pullRequest: result.pullRequest
    });
  } catch (cause) {
    const resetBranch = cause instanceof GitHubSourceError && cause.code === 'branch_conflict';
    await env.DB.prepare(
      `UPDATE article_drafts SET publication_lock = NULL, publication_lock_expires_at = NULL,
       publication_branch = CASE WHEN ? = 1 THEN NULL ELSE publication_branch END
       WHERE id = ? AND publication_lock = ?`
    ).bind(resetBranch ? 1 : 0, id, lock).run();
    if (cause instanceof GitHubSourceError) {
      return error(request, cfg, cause.status && cause.status >= 400 && cause.status < 500 ? cause.status : 503,
        cause.code || 'github_publication_unavailable');
    }
    return error(request, cfg, 503, 'github_publication_unavailable');
  }
}

async function deleteManagedDraft(
  request: Request,
  env: Env,
  cfg: Config,
  userId: string,
  id: string
): Promise<Response> {
  const now = Date.now();
  const [deleted] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM article_drafts WHERE id = ? AND status = 'DRAFT'
       AND (publication_lock IS NULL OR publication_lock_expires_at <= ?)`
    ).bind(id, now),
    env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id)
       SELECT ?, ?, 'draft.delete', ?, 'success', 'draft', ? WHERE changes() = 1`
    ).bind(crypto.randomUUID(), userId, now, id)
  ]);
  return deleted.meta.changes === 1
    ? json(request, cfg, 200, { ok: true })
    : error(request, cfg, 404, 'not_found');
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
  if (!value || value.length > 200 ||
      !/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) return false;
  const [year, month, day] = value.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseManagedDraft(value: unknown): ManagedDraftInput | null {
  if (!isRecord(value)) return null;
  const permalink = typeof value.permalink === 'string' ? value.permalink : null;
  const articleId = value.articleId;
  if (!validArticlePermalink(permalink) ||
      !(articleId === null || typeof articleId === 'string' &&
        /^a_[A-Za-z0-9_-]{22}$/.test(articleId))) return null;
  const draft = parseArticleDraft(value);
  if (!draft) return null;
  const metadata = articleMetadataSchema.safeParse({
    title: draft.title,
    description: draft.description,
    publishedAt: draft.publishedAt,
    permalink,
    categories: draft.categories,
    tags: draft.tags,
    ...(draft.coverUrl ? { cover: draft.coverUrl } : {})
  });
  if (!metadata.success) return null;
  return { ...draft, permalink, articleId: typeof articleId === 'string' ? articleId : null };
}

function storedDraft(row: DraftRow): StoredArticleDraft {
  return {
    id: `d_${row.id}`,
    articlePath: row.article_path,
    baseSha: row.base_sha,
    status: row.status,
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
    updatedAt: row.updated_at,
    publicationState: row.publication_state,
    pullRequestNumber: row.pull_request_number,
    pullRequestUrl: row.pull_request_url,
    submittedRevision: row.submitted_revision
  };
}

async function start(request: Request, env: Env, cfg: Config): Promise<Response> {
  if (!await limit(request, env.AUTH_RATE_LIMITER, 'start')) return error(request, cfg, 429, 'rate_limited');
  const startUrl = new URL(request.url);
  const returnToValues = startUrl.searchParams.getAll('return_to');
  if (returnToValues.length > 1) return error(request, cfg, 400, 'invalid_return_path');
  const returnTo = safeReturnPath(returnToValues[0] ?? null, cfg);
  if (!returnTo) return error(request, cfg, 400, 'invalid_return_path');
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_transactions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO oauth_transactions (state_hash, binding_hash, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(await hash(state), await hash(browser), verifier, returnTo, now + TRANSACTION_SECONDS * 1000)
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

async function callback(request: Request, env: Env, cfg: Config, diagnostics: RequestDiagnostics): Promise<Response> {
  diagnostics.callbackStage = 'rate_limit';
  if (!await limit(request, env.AUTH_RATE_LIMITER, 'callback')) return error(request, cfg, 429, 'rate_limited');
  diagnostics.callbackStage = 'validation';
  const params = new URL(request.url).searchParams;
  const browser = cookieValue(request, TRANSACTION_COOKIE);
  const state = params.get('state');
  const code = params.get('code');
  if (
    params.getAll('state').length !== 1 || params.getAll('code').length !== 1 ||
    params.has('error') || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !code || code.length > 2048 || !browser
  ) return error(request, cfg, 400, 'invalid_callback');

  diagnostics.callbackStage = 'transaction';
  const transaction = await env.DB.prepare(
    `DELETE FROM oauth_transactions
     WHERE state_hash = ? AND binding_hash = ? AND expires_at > ?
     RETURNING verifier, return_to`
  ).bind(await hash(state), await hash(browser), Date.now())
    .first<{ verifier: string; return_to: string }>();
  if (!transaction) return error(request, cfg, 400, 'invalid_callback');

  diagnostics.callbackStage = 'token_exchange_request';
  let exchange: Response;
  try {
    exchange = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
        redirect_uri: `${cfg.api}/auth/github/callback`, code_verifier: transaction.verifier
      })
    });
    if (exchange.status >= 300 && exchange.status < 400) {
      diagnostics.tokenRedirect = classifyTokenRedirect(exchange);
      throw new Error('Token endpoint redirect rejected');
    }
  } catch (error) {
    diagnostics.tokenRequestFailure = classifyTokenRequestFailure(error);
    throw error;
  }
  if (!exchange.ok) {
    diagnostics.tokenResponseStatus = exchange.status;
    return error(request, cfg, 502, 'provider_unavailable');
  }
  diagnostics.callbackStage = 'token_exchange_response';
  const tokenResponse = await providerJson(exchange);
  if (!tokenResponse || typeof tokenResponse !== 'object' ||
      !('access_token' in tokenResponse) || typeof tokenResponse.access_token !== 'string' ||
      !tokenResponse.access_token) {
    const code = tokenResponse && typeof tokenResponse === 'object' && 'error' in tokenResponse
      ? tokenResponse.error : null;
    diagnostics.tokenResponseError =
      code === 'bad_verification_code' || code === 'incorrect_client_credentials' ||
      code === 'redirect_uri_mismatch' || code === 'access_denied' || code === 'unauthorized_client'
        ? code : 'other';
    return error(request, cfg, 502, 'provider_unavailable');
  }
  diagnostics.callbackStage = 'identity';
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
  diagnostics.callbackStage = 'authorization';
  if (!cfg.allowedIds.has(userId)) {
    await audit(env, 'login', 'denied', userId);
    const returnTo = safeReturnPath(transaction.return_to, cfg) ?? '/admin/';
    return redirect(request, cfg, `${cfg.site}${returnTo}#copilot_auth_error=forbidden`, [
      cookie(TRANSACTION_COOKIE, '', 0)
    ]);
  }
  diagnostics.callbackStage = 'handoff';
  const handoff = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_handoffs WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO oauth_handoffs (code_hash, github_user_id, github_login, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(await hash(handoff), userId, login, now + HANDOFF_SECONDS * 1000, now),
    env.DB.prepare('INSERT INTO audit_logs (id, github_user_id, action, created_at, result) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, 'login', now, 'success')
  ]);
  diagnostics.callbackStage = 'redirect';
  const returnTo = safeReturnPath(transaction.return_to, cfg) ?? '/admin/';
  return redirect(request, cfg, `${cfg.site}${returnTo}#copilot_auth=${handoff}`, [
    cookie(TRANSACTION_COOKIE, '', 0)
  ]);
}

async function exchangeHandoff(request: Request, env: Env, cfg: Config): Promise<Response> {
  if (!validUnsafeRequest(request, cfg)) return error(request, cfg, 403, 'forbidden');
  if (!await limit(request, env.AUTH_RATE_LIMITER, 'exchange')) return error(request, cfg, 429, 'rate_limited');
  let payload: unknown;
  try {
    payload = await requestJson(request);
  } catch (cause) {
    return cause instanceof PayloadTooLargeError
      ? error(request, cfg, 413, 'payload_too_large')
      : error(request, cfg, 400, 'invalid_json');
  }
  if (!isRecord(payload) || typeof payload.code !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.code)) {
    return error(request, cfg, 400, 'invalid_handoff');
  }
  const now = Date.now();
  const handoff = await env.DB.prepare(
    `DELETE FROM oauth_handoffs WHERE code_hash = ? AND expires_at > ?
     RETURNING github_user_id, github_login`
  ).bind(await hash(payload.code), now).first<{ github_user_id: string; github_login: string }>();
  if (!handoff || !cfg.allowedIds.has(handoff.github_user_id)) {
    return error(request, cfg, handoff ? 403 : 400, handoff ? 'forbidden' : 'invalid_handoff');
  }
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_sessions
       (id, github_user_id, github_login, session_hash, expires_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), handoff.github_user_id, handoff.github_login,
      await hash(token), now + SESSION_SECONDS * 1000, now, now),
    env.DB.prepare('INSERT INTO audit_logs (id, github_user_id, action, created_at, result) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), handoff.github_user_id, 'session.create', now, 'success')
  ]);
  return json(request, cfg, 200, {
    token,
    authenticated: true,
    user: {
      githubId: handoff.github_user_id,
      githubLogin: handoff.github_login,
      role: 'ADMIN'
    },
    csrfToken: await csrf(token, cfg.csrfSecret)
  });
}

function validUnsafeRequest(request: Request, cfg: Config): boolean {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return request.headers.get('Origin') === cfg.site &&
    (!fetchSite || ['cross-site', 'same-site', 'same-origin'].includes(fetchSite)) &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '');
}

function safeReturnPath(value: string | null, cfg: Config): string | null {
  if (value === null) return '/admin/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') ||
      /[\u0000-\u001f]/.test(value)) return null;
  try {
    const target = new URL(value, cfg.site);
    if (target.origin !== cfg.site || target.search || target.hash) return null;
    if (target.pathname === '/admin/' || target.pathname === '/admin') return '/admin/';
    return /^\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9][A-Za-z0-9-]*\/?$/.test(target.pathname)
      ? target.pathname
      : null;
  } catch {
    return null;
  }
}

async function handle(request: Request, env: Env, cfg: Config, diagnostics: RequestDiagnostics): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const routePath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (request.headers.get('Origin') !== cfg.site || !['GET', 'POST', 'PUT', 'DELETE'].includes(method || '') ||
        requestedHeaders.some((h) => !['authorization', 'content-type', 'x-csrf-token'].includes(h))) {
      return error(request, cfg, 403, 'forbidden');
    }
    const h = headers(request, cfg);
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
    h.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    return new Response(null, { status: 204, headers: h });
  }
  if (path === '/auth/github' && request.method === 'GET') return start(request, env, cfg);
  if (path === '/auth/github/callback' && request.method === 'GET') return callback(request, env, cfg, diagnostics);
  if (path === '/api/auth/exchange' && request.method === 'POST') {
    return exchangeHandoff(request, env, cfg);
  }
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
    if (routePath === '/api/admin/articles' && request.method === 'GET') {
      return adminArticleList(request, env, cfg);
    }
    const articleMatch = /^\/api\/admin\/articles\/([^/]+)$/.exec(routePath);
    if (articleMatch && request.method === 'GET') {
      let id: string;
      try {
        id = decodeURIComponent(articleMatch[1]);
      } catch {
        return error(request, cfg, 400, 'invalid_article_id');
      }
      return adminArticleDetail(request, env, cfg, id, auth.session.github_user_id);
    }
    if (routePath === '/api/admin/drafts' && request.method === 'POST') {
      const csrfError = await requireCsrfProtection(request, auth, cfg);
      if (csrfError) return csrfError;
      if (!await limit(request, env.WRITE_RATE_LIMITER, 'draft-create')) {
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
      return createManagedDraft(request, env, cfg, auth.session.github_user_id, payload);
    }
    const publicationMatch = /^\/api\/admin\/drafts\/([^/]+)\/publish$/.exec(routePath);
    if (publicationMatch && request.method === 'POST') {
      let id: string;
      try {
        id = decodeURIComponent(publicationMatch[1]);
      } catch {
        return error(request, cfg, 400, 'invalid_draft_id');
      }
      if (!/^d_[a-f0-9-]{32,36}$/i.test(id)) return error(request, cfg, 400, 'invalid_draft_id');
      const csrfError = await requireCsrfProtection(request, auth, cfg);
      if (csrfError) return csrfError;
      if (!await limit(request, env.WRITE_RATE_LIMITER, 'draft-publish')) {
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
      return publishManagedDraft(request, env, cfg, auth.session.github_user_id, id.slice(2), payload);
    }
    const draftMatch = /^\/api\/admin\/drafts\/([^/]+)$/.exec(routePath);
    if (draftMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      let id: string;
      try {
        id = decodeURIComponent(draftMatch[1]);
      } catch {
        return error(request, cfg, 400, 'invalid_draft_id');
      }
      if (!/^d_[a-f0-9-]{32,36}$/i.test(id)) return error(request, cfg, 400, 'invalid_draft_id');
      const csrfError = await requireCsrfProtection(request, auth, cfg);
      if (csrfError) return csrfError;
      if (!await limit(request, env.WRITE_RATE_LIMITER, `draft-${request.method.toLowerCase()}`)) {
        return error(request, cfg, 429, 'rate_limited');
      }
      if (request.method === 'DELETE') {
        return deleteManagedDraft(request, env, cfg, auth.session.github_user_id, id.slice(2));
      }
      let payload: unknown;
      try {
        payload = await requestJson(request);
      } catch (cause) {
        return cause instanceof PayloadTooLargeError
          ? error(request, cfg, 413, 'payload_too_large')
          : error(request, cfg, 400, 'invalid_json');
      }
      return updateManagedDraft(request, env, cfg, auth.session.github_user_id, id.slice(2), payload);
    }
    if (path === '/api/admin/drafts' && request.method === 'GET') {
      const permalink = url.searchParams.getAll('permalink');
      if (permalink.length !== 1 || !validArticlePermalink(permalink[0])) {
        return error(request, cfg, 400, 'invalid_draft');
      }
      const row = await env.DB.prepare(
        `SELECT ${DRAFT_COLUMNS}
         FROM article_drafts WHERE permalink = ? AND status IN ('DRAFT', 'PENDING_PUBLICATION')`
      ).bind(permalink[0]).first<DraftRow>();
      if (!row) return error(request, cfg, 404, 'not_found');
      await auditDraft(env, auth.session.github_user_id, 'draft.preview', row.id);
      return json(request, cfg, 200, { draft: storedDraft(row) });
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
      const creating = draft.expectedRevision === null;
      const draftId = crypto.randomUUID();
      const write = creating
        ? env.DB.prepare(
            `INSERT INTO article_drafts
             (id, status, permalink, source_format, title, description, published_at,
              categories_json, tags_json, cover_url, body, revision, created_at, updated_at,
              created_by, updated_by)
             VALUES (?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT(permalink) DO NOTHING`
          ).bind(draftId, permalink, ...values, now, now,
            auth.session.github_user_id, auth.session.github_user_id)
        : env.DB.prepare(
          `UPDATE article_drafts
           SET source_format = ?, title = ?, description = ?, published_at = ?, categories_json = ?,
                 tags_json = ?, cover_url = ?, body = ?, revision = revision + 1, updated_at = ?,
                 updated_by = ?
           WHERE permalink = ? AND revision = ?
             AND status IN ('DRAFT', 'PENDING_PUBLICATION')
             AND (publication_lock IS NULL OR publication_lock_expires_at <= ?)`
          ).bind(...values, now, auth.session.github_user_id, permalink, draft.expectedRevision, now);
      const [writeResult] = await env.DB.batch([
        write,
        env.DB.prepare(
          `INSERT INTO audit_logs
           (id, github_user_id, action, created_at, result, resource_type, resource_id)
           SELECT ?, ?, ?, ?, 'success', 'draft', id
           FROM article_drafts WHERE permalink = ? AND changes() = 1`
        ).bind(
          crypto.randomUUID(),
          auth.session.github_user_id,
          creating ? 'draft.create' : 'draft.update',
          now,
          permalink
        )
      ]);
      if (writeResult.meta.changes !== 1) return error(request, cfg, 409, 'revision_conflict');
      const row = await env.DB.prepare(
        `SELECT ${DRAFT_COLUMNS} FROM article_drafts WHERE permalink = ?`
      ).bind(permalink).first<DraftRow>();
      if (!row) return error(request, cfg, 503, 'draft_save_failed');
      return json(request, cfg, 200, { draft: storedDraft(row) });
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
      return json(request, cfg, 200, { ok: true });
    }
    return error(request, cfg, 404, 'not_found');
  }
  return error(request, cfg, 404, 'not_found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const diagnostics: RequestDiagnostics = {};
    try {
      const response = await handle(request, env, config(env), diagnostics);
      response.headers.set('X-Request-ID', requestId);
      if (diagnostics.tokenResponseStatus !== undefined) {
        console.error(
          `Authentication provider unavailable (${requestId})` +
          ` token_response_status=${diagnostics.tokenResponseStatus}`
        );
      }
      if (diagnostics.tokenResponseError) {
        console.error(
          `Authentication provider unavailable (${requestId})` +
          ` token_response_error=${diagnostics.tokenResponseError}`
        );
      }
      return response;
    } catch {
      console.error(
        `Authentication service unavailable (${requestId})` +
        (diagnostics.callbackStage ? ` callback_stage=${diagnostics.callbackStage}` : '') +
        (diagnostics.tokenRequestFailure ? ` token_request_failure=${diagnostics.tokenRequestFailure}` : '') +
        (diagnostics.tokenRedirect
          ? ` token_redirect_status=${diagnostics.tokenRedirect.status}` +
            ` token_redirect_host=${diagnostics.tokenRedirect.host}` +
            ` token_redirect_same_path=${diagnostics.tokenRedirect.samePath}` +
            ` token_redirect_https=${diagnostics.tokenRedirect.https}`
          : '')
      );
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
