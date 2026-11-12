import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const config = {
  SITE_ORIGIN: 'https://site.example.test',
  API_ORIGIN: 'https://api.example.test',
  GITHUB_CLIENT_ID: 'dummy-client',
  GITHUB_CLIENT_SECRET: 'dummy-secret',
  ADMIN_GITHUB_IDS: '123',
  CSRF_SECRET: 'not-a-real-secret-used-only-in-tests-123',
  GITHUB_APP_ID: '1001',
  GITHUB_APP_INSTALLATION_ID: '2002'
};
const limiter = { limit: vi.fn(async () => ({ success: true })) };
const ip = { 'CF-Connecting-IP': '192.0.2.1' };
const articlePath = 'src/content/articles/existing.mdx';
const articleSha = 'a'.repeat(40);
const articleSource = `---
title: Existing article
description: A published article used by local tests.
publishedAt: 2026-01-01
permalink: 2026/01/01/existing-article
categories:
  - Engineering
tags:
  - Astro
---
# Published source
`;
const baseCommitSha = 'c'.repeat(40);
const updatedArticleSha = 'd'.repeat(40);
let privateKey = '';
let rsaPrivateKey = '';
let githubEnabled = false;
let githubRequests: { url: string; method: string }[] = [];
let currentArticleSha = articleSha;
let currentArticleSource = articleSource;
let branch: string | null = null;
let branchFileSha: string | null = null;
let branchSource = '';
let createdPullRequest = false;
let pullRequestState: 'open' | 'closed' | 'merged' = 'open';

function pem(bytes: Uint8Array, label = 'PRIVATE KEY'): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

function readDerElement(bytes: Uint8Array, offset: number) {
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) length = length * 256 + bytes[offset++];
  }
  const start = offset;
  return { tag, start, end: start + length };
}

function pkcs1FromPkcs8(bytes: Uint8Array): Uint8Array {
  const outer = readDerElement(bytes, 0);
  const version = readDerElement(bytes, outer.start);
  const algorithm = readDerElement(bytes, version.end);
  const key = readDerElement(bytes, algorithm.end);
  if (outer.tag !== 0x30 || algorithm.tag !== 0x30 || key.tag !== 0x04 || key.end !== outer.end) {
    throw new Error('Generated RSA key is not PKCS#8');
  }
  return bytes.slice(key.start, key.end);
}

function encodedBlob(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const bindings = () => ({
  ...env,
  ...config,
  GITHUB_APP_PRIVATE_KEY: privateKey,
  AUTH_RATE_LIMITER: limiter,
  WRITE_RATE_LIMITER: limiter
});
const getCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(';')[0] ?? '';

function invoke(path: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}) {
  const headers = new Headers({ ...ip, ...init.headers });
  const rawToken = headers.get('Cookie') || '';
  if (/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    headers.delete('Cookie');
    headers.set('Authorization', `Bearer ${rawToken}`);
  }
  return worker.fetch(new Request(`https://api.example.test${path}`, {
    ...init,
    headers
  }), { ...bindings(), ...overrides } as typeof env);
}

async function login() {
  const start = await invoke('/auth/github');
  const location = new URL(start.headers.get('Location')!);
  const tx = getCookie(start, '__Host-oauth_transaction');
  const callback = await invoke(
    `/auth/github/callback?state=${location.searchParams.get('state')}&code=dummy-code`,
    { headers: { Cookie: tx } }
  );
  const callbackUrl = new URL(callback.headers.get('Location')!);
  const code = new URLSearchParams(callbackUrl.hash.slice(1)).get('copilot_auth')!;
  const exchange = await invoke('/api/auth/exchange', {
    method: 'POST',
    headers: { Origin: config.SITE_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const { token, csrfToken } = await exchange.json() as { token: string; csrfToken: string };
  return { session: token, csrfToken };
}

function gitHubAppKeyOverrides() {
  return { GITHUB_APP_ID: config.GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID: config.GITHUB_APP_INSTALLATION_ID };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  privateKey = pem(pkcs8);
  rsaPrivateKey = pem(pkcs1FromPkcs8(pkcs8), 'RSA PRIVATE KEY');
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM oauth_transactions'),
    env.DB.prepare('DELETE FROM oauth_handoffs'),
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM article_drafts')
  ]);
  limiter.limit.mockReset().mockResolvedValue({ success: true });
  githubRequests = [];
  githubEnabled = false;
  currentArticleSha = articleSha;
  currentArticleSource = articleSource;
  branch = null;
  branchFileSha = null;
  branchSource = '';
  createdPullRequest = false;
  pullRequestState = 'open';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'dummy-oauth-token' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ id: 123, login: 'approved-user' });
    }
    if (!githubEnabled) throw new Error('Unexpected provider URL');
    githubRequests.push({ url, method });
    if (url === `https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`) {
      expect(method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer [\w.-]+$/);
      return Response.json({ token: 'test-installation-token' });
    }
    const repository = 'https://api.github.com/repos/KevinQCZ/KevinQCZ.github.io';
    if (url === `${repository}/git/trees/master?recursive=1`) {
      return Response.json({
        truncated: false,
        tree: [{ type: 'blob', mode: '100644', path: articlePath, sha: currentArticleSha }]
      });
    }
    if (url.startsWith(`${repository}/git/blobs/`)) {
      const sha = url.slice(`${repository}/git/blobs/`.length);
      if (sha === currentArticleSha) {
        return Response.json({ sha, encoding: 'base64', content: encodedBlob(currentArticleSource) });
      }
      if (sha === branchFileSha) {
        return Response.json({ sha, encoding: 'base64', content: encodedBlob(branchSource) });
      }
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname.startsWith(`${new URL(repository).pathname}/git/ref/heads/`)) {
      const refName = decodeURIComponent(parsedUrl.pathname.slice(
        `${new URL(repository).pathname}/git/ref/heads/`.length
      ));
      if (refName === 'master') return Response.json({ object: { sha: baseCommitSha } });
      if (branch && refName === branch) return Response.json({ object: { sha: baseCommitSha } });
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (parsedUrl.pathname === `${new URL(repository).pathname}/git/refs` && method === 'POST') {
      const payload = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      branch = payload.ref.replace(/^refs\/heads\//, '');
      branchFileSha = currentArticleSha;
      branchSource = currentArticleSource;
      return Response.json({ ref: payload.ref, object: { sha: payload.sha } });
    }
    if (parsedUrl.pathname === `${new URL(repository).pathname}/contents/${articlePath}`) {
      if (method === 'GET' && parsedUrl.searchParams.get('ref') === branch) {
        if (!branchFileSha) return Response.json({ message: 'Not Found' }, { status: 404 });
        return Response.json({ type: 'file', sha: branchFileSha });
      }
      if (method === 'PUT') {
        const payload = JSON.parse(String(init?.body)) as { content: string; branch: string; sha?: string };
        expect(payload.branch).toBe(branch);
        expect(payload.sha).toBe(branchFileSha);
        branchSource = new TextDecoder().decode(Uint8Array.from(atob(payload.content), (value) => value.charCodeAt(0)));
        branchFileSha = updatedArticleSha;
        return Response.json({ content: { sha: branchFileSha }, commit: { sha: 'f'.repeat(40) } });
      }
    }
    if (parsedUrl.pathname === `${new URL(repository).pathname}/pulls` && method === 'GET') {
      return Response.json(createdPullRequest && pullRequestState === 'open' ? [{
        number: 42,
        html_url: 'https://github.com/KevinQCZ/KevinQCZ.github.io/pull/42',
        state: pullRequestState,
        merged_at: null,
        merge_commit_sha: null,
        base: { ref: 'master' }
      }] : []);
    }
    if (parsedUrl.pathname === `${new URL(repository).pathname}/pulls` && method === 'POST') {
      createdPullRequest = true;
      pullRequestState = 'open';
      return Response.json({
        number: 42,
        html_url: 'https://github.com/KevinQCZ/KevinQCZ.github.io/pull/42',
        state: 'open',
        merged_at: null,
        merge_commit_sha: null,
        base: { ref: 'master' }
      });
    }
    if (parsedUrl.pathname === `${new URL(repository).pathname}/pulls/42`) {
      if (method === 'PATCH') pullRequestState = 'open';
      return Response.json({
        number: 42,
        html_url: 'https://github.com/KevinQCZ/KevinQCZ.github.io/pull/42',
        state: pullRequestState === 'merged' ? 'closed' : pullRequestState,
        merged_at: pullRequestState === 'merged' ? '2026-01-02T00:00:00Z' : null,
        merge_commit_sha: pullRequestState === 'merged' ? 'f'.repeat(40) : null,
        base: { ref: 'master' }
      });
    }
    throw new Error(`Unexpected GitHub URL: ${url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('admin article source and draft management', () => {
  it('keeps existing private drafts available when the optional GitHub App is not configured', async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO article_drafts
       (id, status, permalink, source_format, title, description, published_at,
        categories_json, tags_json, cover_url, body, revision, created_at, updated_at)
       VALUES (?, 'DRAFT', ?, 'mdx', ?, ?, ?, '[]', '[]', NULL, ?, 1, 1, 1)`
    ).bind(id, '2026/01/01/private-draft', 'Private draft', 'Not public', '2026-01-01', 'Private body')
      .run();
    const { session } = await login();
    const response = await invoke('/api/admin/articles', { headers: { Cookie: session } }, {
      GITHUB_APP_ID: '',
      GITHUB_APP_INSTALLATION_ID: '',
      GITHUB_APP_PRIVATE_KEY: ''
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      articles: [],
      drafts: [expect.objectContaining({ id: `d_${id}`, title: 'Private draft' })],
      publishedSourceAvailable: false,
      publishedSourceError: 'not_configured'
    });
  });

  it('keeps existing private drafts available when GitHub is temporarily unavailable', async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO article_drafts
       (id, status, permalink, source_format, title, description, published_at,
        categories_json, tags_json, cover_url, body, revision, created_at, updated_at)
       VALUES (?, 'DRAFT', ?, 'mdx', ?, ?, ?, '[]', '[]', NULL, ?, 1, 1, 1)`
    ).bind(id, '2026/01/01/offline-draft', 'Offline draft', 'Not public', '2026-01-01', 'Private body')
      .run();
    const { session } = await login();
    const response = await invoke('/api/admin/articles', { headers: { Cookie: session } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      articles: [],
      drafts: [expect.objectContaining({ id: `d_${id}`, title: 'Offline draft' })],
      publishedSourceAvailable: false,
      publishedSourceError: 'unavailable'
    });
  });

  it('keeps article listing and exact published source behind ADMIN authorization', async () => {
    expect((await invoke('/api/admin/articles')).status).toBe(401);
    const { session } = await login();
    githubEnabled = true;
    const listed = await invoke('/api/admin/articles/', { headers: { Cookie: session } }, gitHubAppKeyOverrides());
    expect(listed.status).toBe(200);
    const list = await listed.json() as { articles: { id: string; articlePath: string; sha: string }[]; drafts: unknown[] };
    expect(list.articles).toEqual([expect.objectContaining({ articlePath, sha: articleSha })]);
    expect(list.drafts).toEqual([]);

    const detail = await invoke(`/api/admin/articles/${list.articles[0].id}`, {
      headers: { Cookie: session }
    }, gitHubAppKeyOverrides());
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      article: {
        articlePath,
        sha: articleSha,
        title: 'Existing article',
        permalink: '2026/01/01/existing-article',
        body: '# Published source\n'
      },
      draft: null
    });
    const unavailable = await invoke(`/api/admin/articles/${list.articles[0].id}`, {
      headers: { Cookie: session }
    }, {
      GITHUB_APP_ID: '',
      GITHUB_APP_INSTALLATION_ID: '',
      GITHUB_APP_PRIVATE_KEY: ''
    });
    expect(unavailable.status).toBe(503);
  });

  it('accepts the PKCS#1 PEM format downloaded from GitHub Apps', async () => {
    const { session } = await login();
    githubEnabled = true;
    const response = await invoke('/api/admin/articles', {
      headers: { Cookie: session }
    }, { ...gitHubAppKeyOverrides(), GITHUB_APP_PRIVATE_KEY: rsaPrivateKey });
    expect(response.status).toBe(200);
  });

  it('creates, retrieves, updates, conflicts, audits and deletes a private revision without writing GitHub', async () => {
    const { session, csrfToken } = await login();
    githubEnabled = true;
    const listed = await invoke('/api/admin/articles', { headers: { Cookie: session } }, gitHubAppKeyOverrides());
    const { articles } = await listed.json() as { articles: { id: string }[] };
    const detail = await invoke(`/api/admin/articles/${articles[0].id}`, {
      headers: { Cookie: session }
    }, gitHubAppKeyOverrides());
    const { article } = await detail.json() as {
      article: { permalink: string; sourceFormat: 'mdx'; title: string; description: string; publishedAt: string; categories: string[]; tags: string[]; coverUrl: null; body: string };
    };
    const headers = {
      Cookie: session,
      Origin: config.SITE_ORIGIN,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    };
    const payload = { ...article, articleId: articles[0].id, expectedRevision: null, title: 'Private edit' };
    const created = await invoke('/api/admin/drafts', {
      method: 'POST', headers, body: JSON.stringify(payload)
    }, gitHubAppKeyOverrides());
    expect(created.status).toBe(201);
    const { draft: createdDraft } = await created.json() as {
      draft: { id: string; baseSha: string; revision: number; status: string; title: string };
    };
    expect(createdDraft).toMatchObject({
      baseSha: articleSha,
      revision: 1,
      status: 'DRAFT',
      title: 'Private edit'
    });

    const privateDetail = await invoke(`/api/admin/articles/${createdDraft.id}`, { headers: { Cookie: session } });
    expect(privateDetail.status).toBe(200);
    expect(await privateDetail.json()).toMatchObject({ draft: { title: 'Private edit', body: article.body } });
    const updatedPayload = { ...payload, articleId: null, expectedRevision: 1, title: 'Updated private edit' };
    const updated = await invoke(`/api/admin/drafts/${createdDraft.id}`, {
      method: 'PUT', headers, body: JSON.stringify(updatedPayload)
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ draft: { revision: 2, title: 'Updated private edit' } });

    const conflict = await invoke(`/api/admin/drafts/${createdDraft.id}`, {
      method: 'PUT', headers, body: JSON.stringify(updatedPayload)
    });
    expect(conflict.status).toBe(409);

    const deleted = await invoke(`/api/admin/drafts/${createdDraft.id}`, {
      method: 'DELETE', headers, body: '{}'
    });
    expect(deleted.status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM article_drafts')
      .first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare('SELECT action FROM audit_logs WHERE resource_type = ? ORDER BY created_at')
      .bind('draft').all<{ action: string }>()).results.map((row) => row.action))
      .toEqual(['draft.create', 'draft.preview', 'draft.update', 'draft.delete']);
    expect(githubRequests.every(({ url, method }) =>
      url.includes('/access_tokens') ? method === 'POST' : method === 'GET'
    )).toBe(true);

    const stillPublished = await invoke(`/api/admin/articles/${articles[0].id}`, {
      headers: { Cookie: session }
    }, gitHubAppKeyOverrides());
    expect(await stillPublished.json()).toMatchObject({ article: { sha: articleSha, body: article.body }, draft: null });
  });

  it('publishes only a saved revision to a generated branch and opens or updates a review PR', async () => {
    const { session, csrfToken } = await login();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO article_drafts
       (id, article_path, base_sha, status, permalink, source_format, title, description,
        published_at, categories_json, tags_json, cover_url, body, revision, created_at,
        updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 'DRAFT', ?, 'mdx', ?, ?, ?, ?, ?, NULL, ?, 1, 1, 1, '123', '123')`
    ).bind(
      id, articlePath, articleSha, '2026/01/01/existing-article', 'Private revision',
      'Private description', '2026-01-01', '["Engineering"]', '["Astro"]', '# Private update'
    ).run();
    const headers = {
      Cookie: session,
      Origin: config.SITE_ORIGIN,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    };
    const endpoint = `/api/admin/drafts/d_${id}/publish`;
    const payload = JSON.stringify({ expectedRevision: 1 });
    expect((await invoke(endpoint, {
      method: 'POST',
      headers: { Origin: config.SITE_ORIGIN, 'Content-Type': 'application/json' },
      body: payload
    })).status).toBe(401);
    expect((await invoke(endpoint, {
      method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'invalid' }, body: payload
    })).status).toBe(403);

    githubEnabled = true;
    const stale = await invoke(endpoint, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) },
      gitHubAppKeyOverrides());
    expect(stale.status).toBe(409);
    expect(githubRequests).toEqual([]);

    currentArticleSha = 'b'.repeat(40);
    const changedBase = await invoke(endpoint, { method: 'POST', headers, body: payload }, gitHubAppKeyOverrides());
    expect(changedBase.status).toBe(409);
    expect(await changedBase.json()).toMatchObject({ error: 'base_conflict' });
    expect(githubRequests.some(({ method, url }) => method === 'POST' && url.endsWith('/git/refs'))).toBe(false);
    currentArticleSha = articleSha;

    const first = await invoke(endpoint, { method: 'POST', headers, body: payload }, gitHubAppKeyOverrides());
    expect(first.status).toBe(200);
    const firstResult = await first.json() as {
      draft: { publicationState: string; pullRequestNumber: number; revision: number };
      pullRequest: { number: number; state: string; url: string };
    };
    expect(firstResult.draft).toMatchObject({
      publicationState: 'OPEN',
      pullRequestNumber: 42,
      revision: 1
    });
    expect((await env.DB.prepare('SELECT publication_branch FROM article_drafts WHERE id = ?')
      .bind(id).first<{ publication_branch: string }>())?.publication_branch)
      .toBe(`blog/draft-${id.replaceAll('-', '')}-r1`);
    expect(firstResult.pullRequest).toMatchObject({
      number: 42,
      state: 'OPEN',
      url: 'https://github.com/KevinQCZ/KevinQCZ.github.io/pull/42'
    });
    expect(githubRequests.some(({ url, method }) => method === 'POST' && url.endsWith('/git/refs'))).toBe(true);
    expect(githubRequests.some(({ url, method }) => method === 'POST' && url.endsWith('/pulls'))).toBe(true);
    const write = githubRequests.find(({ method, url }) => method === 'PUT' && url.includes('/contents/'));
    expect(write?.url).toBe(`https://api.github.com/repos/KevinQCZ/KevinQCZ.github.io/contents/${articlePath}`);
    expect(branchSource).toContain('title: Private revision');
    expect(branchSource).toContain('# Private update');

    const revisionUpdate = await invoke(`/api/admin/drafts/d_${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        articleId: null,
        permalink: '2026/01/01/existing-article',
        sourceFormat: 'mdx',
        title: 'Revised private title',
        description: 'Private description',
        publishedAt: '2026-01-01',
        categories: ['Engineering'],
        tags: ['Astro'],
        coverUrl: null,
        body: '# Revised private update',
        expectedRevision: 1
      })
    });
    expect(revisionUpdate.status).toBe(200);
    const updated = await invoke(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 })
    }, gitHubAppKeyOverrides());
    expect(updated.status).toBe(200);
    expect((await updated.json()).pullRequest).toMatchObject({ number: 42, state: 'OPEN' });
    expect(githubRequests.filter(({ method, url }) => method === 'POST' && url.endsWith('/pulls'))).toHaveLength(1);
    expect(branchSource).toContain('title: Revised private title');
    expect(branchSource).toContain('# Revised private update');

    await invoke(`/api/admin/drafts/d_${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        articleId: null,
        permalink: '2026/01/01/existing-article',
        sourceFormat: 'mdx',
        title: 'Closed PR revision',
        description: 'Private description',
        publishedAt: '2026-01-01',
        categories: ['Engineering'],
        tags: ['Astro'],
        coverUrl: null,
        body: '# Reopen the review',
        expectedRevision: 2
      })
    });
    pullRequestState = 'closed';
    const reopened = await invoke(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3 })
    }, gitHubAppKeyOverrides());
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).pullRequest).toMatchObject({ number: 42, state: 'OPEN' });
    expect(githubRequests.some(({ method, url }) => method === 'PATCH' && url.endsWith('/pulls/42'))).toBe(true);
    expect(githubRequests.filter(({ method, url }) => method === 'POST' && url.endsWith('/pulls'))).toHaveLength(1);

    currentArticleSha = updatedArticleSha;
    currentArticleSource = branchSource;
    pullRequestState = 'merged';
    const refreshed = await invoke('/api/admin/articles', {
      headers: { Cookie: session }
    }, gitHubAppKeyOverrides());
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      articles: [expect.objectContaining({ articlePath, sha: updatedArticleSha })],
      drafts: []
    });
    expect(await env.DB.prepare('SELECT status, publication_state, base_sha FROM article_drafts WHERE id = ?')
      .bind(id).first()).toMatchObject({
        status: 'PUBLISHED',
        publication_state: 'MERGED',
        base_sha: updatedArticleSha
      });
  });

  it('creates a new draft only for a collision-free path and enforces CSRF, metadata, path and origin validation', async () => {
    const { session, csrfToken } = await login();
    githubEnabled = true;
    const headers = {
      Cookie: session,
      Origin: config.SITE_ORIGIN,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    };
    const payload = {
      articleId: null,
      permalink: '2026/01/02/new-article',
      sourceFormat: 'mdx',
      title: 'New article',
      description: 'A private draft.',
      publishedAt: '2026-01-02',
      categories: [],
      tags: [],
      coverUrl: null,
      body: '# Private source',
      expectedRevision: null
    };
    expect((await invoke('/api/admin/drafts', {
      method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'invalid' }, body: JSON.stringify(payload)
    }, gitHubAppKeyOverrides())).status).toBe(403);
    expect((await invoke('/api/admin/drafts', {
      method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify(payload)
    }, gitHubAppKeyOverrides())).status).toBe(403);
    expect((await invoke('/api/admin/drafts', {
      method: 'POST', headers, body: JSON.stringify({ ...payload, permalink: '2026/01/02/../escape' })
    }, gitHubAppKeyOverrides())).status).toBe(400);

    const created = await invoke('/api/admin/drafts', {
      method: 'POST', headers, body: JSON.stringify(payload)
    }, gitHubAppKeyOverrides());
    expect(created.status).toBe(201);
    const { draft } = await created.json() as { draft: { articlePath: string; baseSha: null; permalink: string } };
    expect(draft).toMatchObject({
      articlePath: 'src/content/articles/new-article.mdx',
      baseSha: null,
      permalink: payload.permalink
    });
    expect((await invoke('/api/admin/drafts', {
      method: 'POST', headers, body: JSON.stringify(payload)
    }, gitHubAppKeyOverrides())).status).toBe(409);
  });
});
