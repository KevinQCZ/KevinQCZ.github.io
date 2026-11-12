import { mountArticleEditorUi } from './article-editor-ui';
import {
  AdminAuthError,
  adminFetch,
  authErrorMessage,
  clearAdminSession,
  githubLoginUrl,
  initializeAdminSession
} from './admin-auth';
import type {
  AdminSession,
  ArticleDraft,
  ArticleListEntry,
  ArticleSeed,
  DraftListEntry,
  EditorSeed
} from './article-editor-types';
import '../styles/admin-dashboard.css';

interface ArticleListResponse {
  articles: ArticleListEntry[];
  drafts: DraftListEntry[];
  publishedSourceAvailable: boolean;
  publishedSourceError: 'not_configured' | 'unavailable' | null;
}

interface ArticleDetailResponse {
  article?: ArticleSeed;
  draft?: ArticleDraft | null;
}

function isAdminSession(value: unknown): value is AdminSession {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<AdminSession>;
  return typeof response.accessToken === 'string' && response.accessToken.length > 0 &&
    typeof response.csrfToken === 'string' && response.csrfToken.length > 0 &&
    typeof response.user?.githubId === 'string' &&
    typeof response.user.githubLogin === 'string' && response.user.githubLogin.length > 0 &&
    response.user.role === 'ADMIN';
}

function apiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function validPullRequestUrl(value: unknown, number: unknown): value is string {
  if (typeof value !== 'string' || !Number.isSafeInteger(number)) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' &&
      url.pathname === `/KevinQCZ/KevinQCZ.github.io/pull/${number}` &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isArticleList(value: unknown): value is ArticleListResponse {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ArticleListResponse>;
  return typeof result.publishedSourceAvailable === 'boolean' &&
    (result.publishedSourceError === null || result.publishedSourceError === 'not_configured' ||
      result.publishedSourceError === 'unavailable') &&
    Array.isArray(result.articles) &&
    result.articles.every((article) => typeof article.id === 'string' &&
      typeof article.articlePath === 'string' && typeof article.sha === 'string' &&
      typeof article.fileName === 'string') &&
    Array.isArray(result.drafts) &&
    result.drafts.every((draft) => typeof draft.id === 'string' &&
      typeof draft.permalink === 'string' && typeof draft.title === 'string' &&
      typeof draft.updatedAt === 'number' &&
      ['DRAFT', 'PENDING_PUBLICATION'].includes(String(draft.status)) &&
      ['NOT_SUBMITTED', 'OPEN', 'CLOSED', 'MERGED'].includes(String(draft.publicationState)) &&
      (draft.pullRequestUrl === null && draft.pullRequestNumber === null ||
        validPullRequestUrl(draft.pullRequestUrl, draft.pullRequestNumber)));
}

function isArticleSeed(value: unknown): value is ArticleSeed {
  if (!value || typeof value !== 'object') return false;
  const article = value as Partial<ArticleSeed>;
  return typeof article.id === 'string' && article.id === article.articleId &&
    /^a_[A-Za-z0-9_-]{22}$/.test(article.id) &&
    typeof article.articlePath === 'string' && typeof article.sha === 'string' &&
    typeof article.permalink === 'string' && ['md', 'mdx'].includes(String(article.sourceFormat)) &&
    typeof article.title === 'string' && typeof article.description === 'string' &&
    typeof article.publishedAt === 'string' && Array.isArray(article.categories) &&
    Array.isArray(article.tags) && typeof article.body === 'string';
}

function isArticleDraft(value: unknown): value is ArticleDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ArticleDraft>;
  return typeof draft.id === 'string' && /^d_[a-f0-9-]{32,36}$/i.test(draft.id) &&
    ['DRAFT', 'PENDING_PUBLICATION'].includes(String(draft.status)) && typeof draft.permalink === 'string' &&
    ['md', 'mdx'].includes(String(draft.sourceFormat)) &&
    typeof draft.title === 'string' && typeof draft.description === 'string' &&
    typeof draft.publishedAt === 'string' && Array.isArray(draft.categories) &&
    Array.isArray(draft.tags) && typeof draft.body === 'string' &&
    Number.isSafeInteger(draft.revision) && typeof draft.updatedAt === 'number' &&
    ['NOT_SUBMITTED', 'OPEN', 'CLOSED', 'MERGED'].includes(String(draft.publicationState)) &&
    (draft.pullRequestUrl === null && draft.pullRequestNumber === null ||
      validPullRequestUrl(draft.pullRequestUrl, draft.pullRequestNumber));
}

function seedFromDraft(draft: ArticleDraft): EditorSeed {
  return {
    id: '',
    articleId: null,
    articlePath: draft.articlePath ?? '',
    sha: draft.baseSha ?? '',
    permalink: draft.permalink,
    sourceFormat: draft.sourceFormat,
    title: draft.title,
    description: draft.description,
    publishedAt: draft.publishedAt,
    categories: [...draft.categories],
    tags: [...draft.tags],
    coverUrl: draft.coverUrl,
    body: draft.body
  };
}

function generatedNewSeed(): EditorSeed {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: '',
    articleId: null,
    articlePath: '',
    sha: '',
    permalink: `${today.replaceAll('-', '/')}/new-article`,
    sourceFormat: 'mdx',
    title: 'New article',
    description: '',
    publishedAt: today,
    categories: [],
    tags: [],
    coverUrl: null,
    body: ''
  };
}

export async function initAdminDashboard(
  root: HTMLElement,
  fetcher: typeof fetch = fetch,
  navigate: (url: string) => void = (url) => window.location.assign(url)
): Promise<void> {
  const api = apiOrigin(root.dataset.apiOrigin);
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const login = root.querySelector<HTMLButtonElement>('[data-login]')!;
  const logout = root.querySelector<HTMLButtonElement>('[data-logout]')!;
  const tools = root.querySelector<HTMLElement>('[data-admin-tools]')!;
  const articleList = root.querySelector<HTMLUListElement>('[data-article-list]')!;
  const draftList = root.querySelector<HTMLUListElement>('[data-draft-list]')!;
  const listStatus = root.querySelector<HTMLElement>('[data-list-status]')!;
  const createButton = root.querySelector<HTMLButtonElement>('[data-new-article]')!;
  const editorHost = root.querySelector<HTMLElement>('[data-editor-host]')!;
  const editorMount = root.querySelector<HTMLElement>('[data-editor-mount]')!;
  let session: AdminSession | null = null;
  let articles: ArticleListEntry[] = [];
  let drafts: DraftListEntry[] = [];
  let publishedSourceAvailable = false;
  let activeDraftId: string | null = null;

  const show = (message: string, canLogin = false, canLogout = false) => {
    status.textContent = message;
    login.hidden = !canLogin;
    logout.hidden = !canLogout;
  };

  if (!api) {
    show('The administrator service is not configured.');
    return;
  }

  login.addEventListener('click', () => navigate(githubLoginUrl(api, '/admin/')));

  const closeEditor = () => {
    activeDraftId = null;
    editorHost.hidden = true;
    editorMount.replaceChildren();
  };

  const request = (path: string, init?: RequestInit) =>
    adminFetch(api, path, init, fetcher, session);

  const renderList = () => {
    articleList.replaceChildren();
    draftList.replaceChildren();
    for (const article of articles) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = article.fileName;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-secondary';
      button.dataset.editArticle = article.id;
      button.textContent = 'Edit published article';
      item.append(label, button);
      articleList.append(item);
    }
    for (const draft of drafts) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${draft.title} — /${draft.permalink}/ — ${draft.publicationState.replace('_', ' ').toLowerCase()}`;
      if (draft.pullRequestUrl && draft.pullRequestNumber &&
          validPullRequestUrl(draft.pullRequestUrl, draft.pullRequestNumber)) {
        const pullRequest = document.createElement('a');
        pullRequest.href = draft.pullRequestUrl;
        pullRequest.target = '_blank';
        pullRequest.rel = 'noopener noreferrer';
        pullRequest.textContent = `PR #${draft.pullRequestNumber}`;
        item.append(label, pullRequest);
      } else {
        item.append(label);
      }
      const updated = document.createElement('time');
      updated.dateTime = new Date(draft.updatedAt).toISOString();
      updated.textContent = `Saved ${new Date(draft.updatedAt).toLocaleString()}`;
      const continueButton = document.createElement('button');
      continueButton.type = 'button';
      continueButton.className = 'button-secondary';
      continueButton.dataset.continueDraft = draft.id;
      continueButton.textContent = 'Continue editing';
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'button-secondary';
      deleteButton.dataset.deleteDraft = draft.id;
      deleteButton.textContent = 'Delete draft';
      item.append(updated, continueButton);
      if (draft.status === 'DRAFT') item.append(deleteButton);
      draftList.append(item);
    }
  };

  const refreshList = async () => {
    listStatus.textContent = 'Loading articles and drafts…';
    try {
      const response = await request('/api/admin/articles');
      if (response.status === 401 || response.status === 403) {
        clearAdminSession(api);
        session = null;
        tools.hidden = true;
        closeEditor();
        articles = [];
        drafts = [];
        renderList();
        show(response.status === 401 ? 'Your session has expired.' : 'This account is not authorized.');
        return;
      }
      if (!response.ok) throw new Error('Article list unavailable');
      const result: unknown = await response.json();
      if (!isArticleList(result)) throw new Error('Invalid article list');
      articles = result.articles;
      drafts = result.drafts;
      publishedSourceAvailable = result.publishedSourceAvailable;
      renderList();
      createButton.disabled = !publishedSourceAvailable;
      listStatus.textContent = publishedSourceAvailable
        ? `${articles.length} published articles and ${drafts.length} private drafts.`
        : `${drafts.length} private drafts. Published source ${result.publishedSourceError === 'not_configured'
          ? 'is not configured' : 'is unavailable'}; existing drafts remain accessible.`;
    } catch {
      articles = [];
      drafts = [];
      publishedSourceAvailable = false;
      createButton.disabled = true;
      renderList();
      listStatus.textContent = 'Could not load articles and drafts. Check the local GitHub App read-only configuration.';
    }
  };

  const openEditor = async (seed: EditorSeed, draft: ArticleDraft | null) => {
    if (!session) return;
    activeDraftId = draft?.id ?? null;
    editorHost.hidden = false;
    editorMount.replaceChildren();
    await mountArticleEditorUi(
      editorMount,
      api,
      seed,
      session,
      fetcher,
      draft,
      {
        onSaved: (saved) => {
          activeDraftId = saved.id;
          void refreshList();
        },
        onClose: closeEditor
      }
    );
    editorMount.querySelector<HTMLButtonElement>('[data-editor-toggle]')?.click();
  };

  const openPublished = async (id: string) => {
    listStatus.textContent = 'Loading published source…';
    try {
      const response = await request(`/api/admin/articles/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Published source unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('Invalid article response');
      const detail = result as ArticleDetailResponse;
      if (!isArticleSeed(detail.article) ||
          !(detail.draft === null || isArticleDraft(detail.draft))) throw new Error('Invalid article response');
      await openEditor(detail.article, detail.draft);
      listStatus.textContent = '';
    } catch {
      listStatus.textContent = 'Could not load the published source or private draft.';
    }
  };

  const openDraft = async (id: string) => {
    listStatus.textContent = 'Loading private draft…';
    try {
      const response = await request(`/api/admin/articles/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Draft unavailable');
      const result = await response.json() as { draft?: unknown };
      if (!isArticleDraft(result.draft)) throw new Error('Invalid draft response');
      await openEditor(seedFromDraft(result.draft), result.draft);
      listStatus.textContent = '';
    } catch {
      listStatus.textContent = 'Could not load the private draft.';
    }
  };

  createButton.addEventListener('click', () => {
    if (!publishedSourceAvailable) return;
    void openEditor(generatedNewSeed(), null);
  });

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const publishedId = target.dataset.editArticle;
    const draftId = target.dataset.continueDraft;
    const deleteId = target.dataset.deleteDraft;
    if (publishedId) void openPublished(publishedId);
    if (draftId) void openDraft(draftId);
    if (deleteId) {
      if (!session || !window.confirm(
        'Delete this private draft? This also discards its unsaved editor changes. Any published article will remain unchanged.'
      )) return;
      void request(`/api/admin/drafts/${encodeURIComponent(deleteId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: '{}'
      }).then(async (response) => {
        if (!response.ok) throw new Error('Draft deletion failed');
        if (activeDraftId === deleteId) closeEditor();
        await refreshList();
      }).catch(() => {
        listStatus.textContent = 'Draft could not be deleted. Try again.';
      });
    }
  });

  logout.addEventListener('click', async () => {
    if (!session) return;
    logout.disabled = true;
    try {
      const response = await request('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: '{}'
      });
      if (!response.ok) throw new Error('Sign-out failed');
      session = null;
      clearAdminSession(api);
      tools.hidden = true;
      closeEditor();
      articles = [];
      drafts = [];
      renderList();
      show('Signed out.', true);
    } catch {
      show('Sign-out failed. Please try again.', false, true);
    } finally {
      logout.disabled = false;
    }
  });

  show('Checking sign-in status…');
  try {
    session = await initializeAdminSession(api, fetcher);
    if (!session) {
      show('Not signed in.', true);
      return;
    }
    if (!isAdminSession(session)) throw new Error('Invalid session response');
    tools.hidden = false;
    createButton.hidden = false;
    show(`Signed in as ${session.user.githubLogin} (ADMIN).`, false, true);
    await refreshList();
  } catch (cause) {
    show(cause instanceof AdminAuthError
      ? authErrorMessage(cause.code)
      : 'The administrator service is unavailable.', true);
  }
}
