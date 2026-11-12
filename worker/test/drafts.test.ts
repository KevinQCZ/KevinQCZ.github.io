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
let privateKey = '';
let rsaPrivateKey = '';
let githubEnabled = false;
let githubRequests: { url: string; method: string }[] = [];

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
  return worker.fetch(new Request(`https://api.example.test${path}`, {
    ...init,
    headers: { ...ip, ...init.headers }
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
  const session = getCookie(callback, '__Host-admin_session');
  const me = await invoke('/api/me', { headers: { Cookie: session } });
  const { csrfToken } = await me.json() as { csrfToken: string };
  return { session, csrfToken };
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
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM article_drafts')
  ]);
  limiter.limit.mockReset().mockResolvedValue({ success: true });
  githubRequests = [];
  githubEnabled = false;
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
    if (url === 'https://api.github.com/repos/KevinQCZ/KevinQCZ.github.io/git/trees/master?recursive=1') {
      return Response.json({
        truncated: false,
        tree: [{ type: 'blob', mode: '100644', path: articlePath, sha: articleSha }]
      });
    }
    if (url === `https://api.github.com/repos/KevinQCZ/KevinQCZ.github.io/git/blobs/${articleSha}`) {
      return Response.json({ sha: articleSha, encoding: 'base64', content: encodedBlob(articleSource) });
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
