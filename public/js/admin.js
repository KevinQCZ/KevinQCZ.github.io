export function initAdmin(root, fetcher = fetch, navigate = (url) => window.location.assign(url)) {
  const status = root.querySelector('[data-status]');
  const login = root.querySelector('[data-login]');
  const logout = root.querySelector('[data-logout]');
  let token = null;
  let api;

  function show(message, canLogin = false, canLogout = false) {
    status.textContent = message;
    login.hidden = !canLogin;
    logout.hidden = !canLogout;
  }

  try {
    const url = new URL(root.dataset.apiOrigin);
    if (url.protocol !== 'https:' || url.origin !== root.dataset.apiOrigin || url.username || url.password) {
      throw new Error('Invalid API origin');
    }
    api = url.origin;
  } catch {
    show('The administrator service is not configured.');
    return;
  }

  login.addEventListener('click', () => navigate(`${api}/auth/github`));
  logout.addEventListener('click', async () => {
    if (!token) return;
    logout.disabled = true;
    try {
      const response = await fetcher(`${api}/api/logout`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: '{}'
      });
      if (!response.ok) throw new Error('Sign-out failed');
      token = null;
      show('Signed out.', true);
    } catch {
      show('Sign-out failed. Please try again.', false, true);
    } finally {
      logout.disabled = false;
    }
  });

  show('Checking sign-in status…');
  return fetcher(`${api}/api/me`, { credentials: 'include' })
    .then(async (response) => {
      if (response.status === 401) {
        show('Not signed in.', true);
      } else if (response.status === 403) {
        show('This account is not authorized.');
      } else if (response.ok) {
        const data = await response.json();
        if (
          data.authenticated !== true || data.user?.role !== 'ADMIN' ||
          typeof data.user.githubId !== 'string' || typeof data.user.githubLogin !== 'string' ||
          !data.user.githubLogin || typeof data.csrfToken !== 'string' || !data.csrfToken
        ) {
          throw new Error('Invalid session response');
        }
        token = data.csrfToken;
        show(`Signed in as ${data.user.githubLogin} (ADMIN).`, false, true);
      } else {
        throw new Error('Session check failed');
      }
    })
    .catch(() => show('The administrator service is unavailable.'));
}
