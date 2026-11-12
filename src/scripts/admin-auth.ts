import type { AdminSession } from './article-editor-types';

interface PublicSession {
  authenticated: true;
  csrfToken: string;
  user: AdminSession['user'];
}

interface ActiveSession {
  apiOrigin: string;
  value: AdminSession;
}

let activeSession: ActiveSession | null = null;

export class AdminAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isPublicSession(value: unknown): value is PublicSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<PublicSession>;
  return session.authenticated === true && typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0 && typeof session.user?.githubId === 'string' &&
    typeof session.user.githubLogin === 'string' && session.user.githubLogin.length > 0 &&
    session.user.role === 'ADMIN';
}

function consumeHandoff(): { code: string | null; error: string | null } {
  if (typeof window === 'undefined' || !window.location.hash) return { code: null, error: null };
  const params = new URLSearchParams(window.location.hash.slice(1));
  const codes = params.getAll('copilot_auth');
  const errors = params.getAll('copilot_auth_error');
  if (!codes.length && !errors.length) return { code: null, error: null };
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  const code = codes[0];
  if (codes.length === 1 && code && /^[A-Za-z0-9_-]{43}$/.test(code) && !errors.length) {
    return { code, error: null };
  }
  const error = errors[0];
  if (!codes.length && errors.length === 1 && error) return { code: null, error };
  return { code: null, error: 'invalid_handoff' };
}

export async function initializeAdminSession(
  apiOrigin: string,
  fetcher: typeof fetch = fetch
): Promise<AdminSession | null> {
  const handoff = consumeHandoff();
  if (handoff.error) throw new AdminAuthError(handoff.error);
  if (handoff.code) {
    const response = await fetcher(`${apiOrigin}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: handoff.code }),
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new AdminAuthError(typeof body?.error === 'string' ? body.error : 'exchange_failed');
    }
    const result: unknown = await response.json();
    const token = result && typeof result === 'object'
      ? (result as { token?: unknown }).token
      : null;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !isPublicSession(result)) {
      throw new AdminAuthError('invalid_session_response');
    }
    activeSession = {
      apiOrigin,
      value: {
        accessToken: token,
        csrfToken: result.csrfToken,
        user: result.user
      }
    };
  }

  if (!activeSession || activeSession.apiOrigin !== apiOrigin) return null;
  const response = await fetcher(`${apiOrigin}/api/me`, {
    headers: { Authorization: `Bearer ${activeSession.value.accessToken}` },
    cache: 'no-store',
    credentials: 'omit'
  });
  if (response.status === 401 || response.status === 403) {
    activeSession = null;
    return null;
  }
  if (!response.ok) throw new AdminAuthError('session_check_failed');
  const result: unknown = await response.json();
  if (!isPublicSession(result)) throw new AdminAuthError('invalid_session_response');
  activeSession.value = { ...activeSession.value, csrfToken: result.csrfToken, user: result.user };
  return activeSession.value;
}

export function adminFetch(
  apiOrigin: string,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
  session?: AdminSession | null
): Promise<Response> {
  const current = session ?? (activeSession?.apiOrigin === apiOrigin ? activeSession.value : null);
  if (!current) {
    throw new AdminAuthError('not_authenticated');
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${current.accessToken}`);
  return fetcher(`${apiOrigin}${path}`, {
    ...init,
    headers,
    cache: init.cache ?? 'no-store',
    credentials: 'omit'
  });
}

export function clearAdminSession(apiOrigin: string): void {
  if (activeSession?.apiOrigin === apiOrigin) activeSession = null;
}

export function githubLoginUrl(apiOrigin: string, returnTo: string): string {
  const url = new URL('/auth/github', apiOrigin);
  url.searchParams.set('return_to', returnTo);
  return url.href;
}

export function authErrorMessage(code: string): string {
  if (code === 'forbidden') return 'This GitHub account is not authorized as an administrator.';
  if (code === 'invalid_handoff') return 'The sign-in link expired or was already used. Please sign in again.';
  return 'Sign-in could not be completed. Please try again.';
}
