import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const config = {
  SITE_ORIGIN: 'https://site.example.test',
  API_ORIGIN: 'https://api.example.test',
  GITHUB_CLIENT_ID: 'dummy-client',
  GITHUB_CLIENT_SECRET: 'dummy-secret',
  ADMIN_GITHUB_IDS: '123',
  CSRF_SECRET: 'not-a-real-secret-used-only-in-tests-123',
};
const limiter = { limit: vi.fn(async () => ({ success: true })) };
const bindings = () => ({ ...env, ...config, AUTH_RATE_LIMITER: limiter, WRITE_RATE_LIMITER: limiter });
const ip = { 'CF-Connecting-IP': '192.0.2.1' };
const getCookie = (response: Response, name: string) => {
  const headers = response.headers.getSetCookie();
  return headers.find((value) => value.startsWith(`${name}=`))?.split(';')[0] ?? '';
};
const invoke = (path: string, init: RequestInit = {}, overrides = {}) =>
  worker.fetch(new Request(`https://api.example.test${path}`, {
    ...init, headers: { ...ip, ...init.headers }
  }), { ...bindings(), ...overrides });

async function login() {
  const start = await invoke('/auth/github');
  const location = new URL(start.headers.get('Location')!);
  const tx = getCookie(start, '__Host-oauth_transaction');
  const callback = await invoke(`/auth/github/callback?state=${location.searchParams.get('state')}&code=dummy-code`, {
    headers: { Cookie: tx }
  });
  return { start, location, tx, callback, session: getCookie(callback, '__Host-admin_session') };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM oauth_transactions'),
    env.DB.prepare('DELETE FROM audit_logs')
  ]);
  limiter.limit.mockReset().mockResolvedValue({ success: true });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (input === 'https://github.com/login/oauth/access_token') {
      expect(init?.method).toBe('POST');
      return Response.json({ access_token: 'dummy-oauth-token' });
    }
    if (input === 'https://api.github.com/user') return Response.json({ id: 123 });
    throw new Error('Unexpected provider URL');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('OAuth and sessions', () => {
  it('uses bound single-use state, PKCE, hash-only sessions and secure cookies', async () => {
    const result = await login();
    expect(result.start.status).toBe(302);
    expect(result.location.origin).toBe('https://github.com');
    expect(result.location.searchParams.get('redirect_uri')).toBe(`${config.API_ORIGIN}/auth/github/callback`);
    expect(result.location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.start.headers.get('Set-Cookie')).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    expect(result.callback.status).toBe(302);
    expect(result.callback.headers.get('Location')).toBe(`${config.SITE_ORIGIN}/admin/`);
    expect(result.callback.headers.get('Set-Cookie')).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    expect(result.session).toBeTruthy();
    const tokenBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenBody.code_verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(result.location.searchParams.get('code_challenge'));
    const stored = await env.DB.prepare('SELECT * FROM admin_sessions').first<Record<string, unknown>>();
    expect(stored?.github_user_id).toBe('123');
    expect(stored?.session_hash).not.toBe(result.session.split('=')[1]);
    expect(Number(stored?.expires_at) - Number(stored?.created_at)).toBe(86400000);
    const replay = await invoke(`/auth/github/callback?state=${result.location.searchParams.get('state')}&code=again`, {
      headers: { Cookie: result.tx }
    });
    expect(replay.status).toBe(400);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched browser and expired or concurrently replayed state', async () => {
    const start = await invoke('/auth/github');
    const url = new URL(start.headers.get('Location')!);
    const tx = getCookie(start, '__Host-oauth_transaction');
    const path = `/auth/github/callback?state=${url.searchParams.get('state')}&code=abc`;
    expect((await invoke(path, { headers: { Cookie: '__Host-oauth_transaction=' + 'a'.repeat(43) } })).status).toBe(400);
    const responses = await Promise.all([invoke(path, { headers: { Cookie: tx } }), invoke(path, { headers: { Cookie: tx } })]);
    expect(responses.map((r) => r.status).sort()).toEqual([302, 400]);
    const expired = await invoke('/auth/github');
    const expiredUrl = new URL(expired.headers.get('Location')!);
    await env.DB.prepare('UPDATE oauth_transactions SET expires_at = 0').run();
    expect((await invoke(`/auth/github/callback?state=${expiredUrl.searchParams.get('state')}&code=abc`, {
      headers: { Cookie: getCookie(expired, '__Host-oauth_transaction') }
    })).status).toBe(400);
  });

  it('denies unauthorized and unsafe provider identities without a session', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === 'https://github.com/login/oauth/access_token'
        ? Response.json({ access_token: 'dummy-oauth-token' })
        : Response.json({ id: 999 })
    );
    const rejected = await login();
    expect(rejected.callback.status).toBe(403);
    expect(rejected.session).toBe('');
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === 'https://github.com/login/oauth/access_token'
        ? Response.json({ access_token: 'dummy-oauth-token' })
        : new Response('{"id":9007199254740993}', { headers: { 'Content-Type': 'application/json' } })
    );
    expect((await login()).callback.status).toBe(502);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first<{ count: number }>())?.count).toBe(0);
  });

  it('rejects provider denial and failures without leaking secrets', async () => {
    const start = await invoke('/auth/github');
    const url = new URL(start.headers.get('Location')!);
    const denied = await invoke(`/auth/github/callback?state=${url.searchParams.get('state')}&error=access_denied`, {
      headers: { Cookie: getCookie(start, '__Host-oauth_transaction') }
    });
    expect(denied.status).toBe(400);
    vi.mocked(fetch).mockResolvedValue(new Response('dummy-secret dummy-code', { status: 500 }));
    const failed = await login();
    expect(failed.callback.status).toBe(502);
    expect(await failed.callback.text()).not.toMatch(/dummy-secret|dummy-code|dummy-oauth-token/);
  });

  it('rejects oversized provider responses and never follows provider redirects', async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return new Response('x'.repeat(65537));
    });
    const result = await login();
    expect(result.callback.status).toBe(503);
    expect(result.session).toBe('');
  });

  it('rejects malformed or duplicate callback parameters and duplicate cookies', async () => {
    const start = await invoke('/auth/github');
    const url = new URL(start.headers.get('Location')!);
    const tx = getCookie(start, '__Host-oauth_transaction');
    const state = url.searchParams.get('state');
    expect((await invoke(`/auth/github/callback?state=${state}&state=${state}&code=x`, { headers: { Cookie: tx } })).status).toBe(400);
    expect((await invoke(`/auth/github/callback?state=${state}&code=x`, { headers: { Cookie: `${tx}; ${tx}` } })).status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rotates an existing session on login', async () => {
    const first = await login();
    const start = await invoke('/auth/github');
    const url = new URL(start.headers.get('Location')!);
    const next = await invoke(`/auth/github/callback?state=${url.searchParams.get('state')}&code=abc`, {
      headers: { Cookie: `${getCookie(start, '__Host-oauth_transaction')}; ${first.session}` }
    });
    expect(next.status).toBe(302);
    expect((await invoke('/api/me', { headers: { Cookie: first.session } })).status).toBe(401);
    expect((await invoke('/api/me', { headers: { Cookie: getCookie(next, '__Host-admin_session') } })).status).toBe(200);
  });
});

describe('authorization, CSRF, CORS and failure behavior', () => {
  it('distinguishes missing, revoked, expired and removed identities', async () => {
    expect((await invoke('/api/me')).status).toBe(401);
    expect((await invoke('/api/admin/articles')).status).toBe(401);
    const { session } = await login();
    expect((await invoke('/api/admin/articles', { headers: { Cookie: session } })).status).toBe(404);
    expect((await invoke('/api/me', { headers: { Cookie: session } }, { ADMIN_GITHUB_IDS: '999' })).status).toBe(403);
    expect((await invoke('/api/admin/articles', { headers: { Cookie: session } }, { ADMIN_GITHUB_IDS: '999' })).status).toBe(403);
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = 0').run();
    expect((await invoke('/api/me', { headers: { Cookie: session } })).status).toBe(401);
  });

  it('requires origin, metadata and CSRF for logout and confirms revocation', async () => {
    const { session } = await login();
    const me = await invoke('/api/me', { headers: { Cookie: session, Origin: config.SITE_ORIGIN } });
    const data = await me.json() as { csrfToken: string };
    expect(me.headers.get('Access-Control-Allow-Origin')).toBe(config.SITE_ORIGIN);
    expect(me.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(me.headers.get('Cache-Control')).toBe('no-store');
    const good = { Cookie: session, Origin: config.SITE_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken };
    expect((await invoke('/api/logout', { method: 'POST', headers: { ...good, Origin: 'https://evil.test' } })).status).toBe(403);
    const { Origin: _origin, ...missingOrigin } = good;
    expect((await invoke('/api/logout', { method: 'POST', headers: missingOrigin })).status).toBe(403);
    expect((await invoke('/api/logout', { method: 'POST', headers: { ...good, 'X-CSRF-Token': 'bad' } })).status).toBe(403);
    expect((await invoke('/api/logout', { method: 'POST', headers: { ...good, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await invoke('/api/logout', { method: 'POST', headers: { ...good, 'Content-Type': 'text/plain' } })).status).toBe(403);
    const logout = await invoke('/api/logout', { method: 'POST', headers: good });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await invoke('/api/logout', { method: 'POST', headers: good })).status).toBe(401);
  });

  it('restricts preflight and fails closed on limit or missing configuration', async () => {
    const preflight = await invoke('/api/logout', { method: 'OPTIONS', headers: {
      Origin: config.SITE_ORIGIN, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-csrf-token'
    } });
    expect(preflight.status).toBe(204);
    expect((await invoke('/api/logout', { method: 'OPTIONS', headers: {
      Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST'
    } })).headers.has('Access-Control-Allow-Origin')).toBe(false);
    limiter.limit.mockResolvedValueOnce({ success: false });
    expect((await invoke('/auth/github')).status).toBe(429);
    limiter.limit.mockRejectedValueOnce(new Error('dummy-secret'));
    const unavailable = await invoke('/auth/github');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('dummy-secret');
    expect((await invoke('/auth/github', {}, { ADMIN_GITHUB_IDS: '' })).status).toBe(503);
    expect((await invoke('/api/me', {}, { DB: null })).status).toBe(401);
    const { session } = await login();
    expect((await invoke('/api/me', { headers: { Cookie: session } }, { DB: null })).status).toBe(503);
  });

  it('rate limits callback and logout without claiming logout succeeded', async () => {
    const { session } = await login();
    const me = await invoke('/api/me', { headers: { Cookie: session } });
    const data = await me.json() as { csrfToken: string };
    limiter.limit.mockResolvedValueOnce({ success: false });
    expect((await invoke('/auth/github/callback?state=x&code=x')).status).toBe(429);
    limiter.limit.mockResolvedValueOnce({ success: false });
    const denied = await invoke('/api/logout', { method: 'POST', headers: {
      Cookie: session, Origin: config.SITE_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken
    } });
    expect(denied.status).toBe(429);
    expect(denied.headers.has('Set-Cookie')).toBe(false);
    expect((await invoke('/api/me', { headers: { Cookie: session } })).status).toBe(200);
  });
});
