import type {
  AdminArticleDetail,
  AdminSession,
  ArticleDraft,
  ArticleLocator,
  ArticleSeed
} from './article-editor-types';

interface EditorModule {
  mountArticleEditorUi: (
    root: HTMLElement,
    apiOrigin: string,
    seed: ArticleSeed,
    session: AdminSession,
    fetcher: typeof fetch,
    draft: ArticleDraft | null
  ) => Promise<void>;
}

interface Dependencies {
  fetcher?: typeof fetch;
  loadEditor?: () => Promise<EditorModule>;
}

function isArticleLocator(value: unknown): value is ArticleLocator {
  if (!value || typeof value !== 'object') return false;
  const locator = value as Partial<ArticleLocator>;
  return typeof locator.articleId === 'string' && /^a_[A-Za-z0-9_-]{22}$/.test(locator.articleId) &&
    typeof locator.permalink === 'string';
}

function isArticleSeed(value: unknown): value is ArticleSeed {
  if (!value || typeof value !== 'object') return false;
  const seed = value as Partial<ArticleSeed>;
  return typeof seed.id === 'string' && /^a_[A-Za-z0-9_-]{22}$/.test(seed.id) &&
    seed.articleId === seed.id && typeof seed.articlePath === 'string' &&
    typeof seed.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(seed.sha) &&
    typeof seed.permalink === 'string' &&
    typeof seed.sourceFormat === 'string' && ['md', 'mdx'].includes(seed.sourceFormat) &&
    typeof seed.title === 'string' && typeof seed.description === 'string' &&
    typeof seed.publishedAt === 'string' && Array.isArray(seed.categories) &&
    seed.categories.every((item) => typeof item === 'string') &&
    Array.isArray(seed.tags) && seed.tags.every((item) => typeof item === 'string') &&
    (seed.coverUrl === null || typeof seed.coverUrl === 'string') &&
    typeof seed.body === 'string';
}

function isArticleDraft(value: unknown): value is ArticleDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ArticleDraft>;
  return typeof draft.id === 'string' && /^d_[a-f0-9-]{32,36}$/i.test(draft.id) &&
    (draft.articlePath === null || typeof draft.articlePath === 'string') &&
    (draft.baseSha === null || typeof draft.baseSha === 'string') && draft.status === 'DRAFT' &&
    typeof draft.permalink === 'string' && ['md', 'mdx'].includes(String(draft.sourceFormat)) &&
    typeof draft.title === 'string' && typeof draft.description === 'string' &&
    typeof draft.publishedAt === 'string' && Array.isArray(draft.categories) &&
    draft.categories.every((item) => typeof item === 'string') &&
    Array.isArray(draft.tags) && draft.tags.every((item) => typeof item === 'string') &&
    (draft.coverUrl === null || typeof draft.coverUrl === 'string') &&
    typeof draft.body === 'string' && Number.isSafeInteger(draft.revision) &&
    typeof draft.createdAt === 'number' && typeof draft.updatedAt === 'number';
}

function isAdminSession(value: unknown): value is AdminSession {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<AdminSession>;
  return typeof response.csrfToken === 'string' && response.csrfToken.length > 0 &&
    typeof response.user?.githubId === 'string' &&
    typeof response.user.githubLogin === 'string' && response.user.githubLogin.length > 0 &&
    response.user.role === 'ADMIN';
}

function configuredApiOrigin(value: string | undefined): string | null {
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

export async function mountArticleEditor(
  root: HTMLElement,
  { fetcher = fetch, loadEditor = () => import('./article-editor-ui') }: Dependencies = {}
): Promise<void> {
  const apiOrigin = configuredApiOrigin(root.dataset.apiOrigin);
  if (!apiOrigin) return;

  let locator: unknown;
  try {
    locator = JSON.parse(root.dataset.articleLocator || '');
  } catch {
    return;
  }
  if (!isArticleLocator(locator)) return;

  try {
    const response = await fetcher(`${apiOrigin}/api/me`, { credentials: 'include' });
    if (!response.ok) return;
    const session = await response.json();
    if (!isAdminSession(session)) return;
    const detailResponse = await fetcher(
      `${apiOrigin}/api/admin/articles/${encodeURIComponent(locator.articleId)}`,
      { credentials: 'include' }
    );
    if (!detailResponse.ok) return;
    const detail = await detailResponse.json() as Partial<AdminArticleDetail>;
    if (!isArticleSeed(detail.article) || detail.article.id !== locator.articleId ||
        detail.article.permalink !== locator.permalink ||
        (detail.draft !== null && !isArticleDraft(detail.draft))) return;
    const editor = await loadEditor();
    await editor.mountArticleEditorUi(root, apiOrigin, detail.article, session, fetcher, detail.draft);
  } catch {
    // Public article rendering remains available when the admin service is not.
  }
}
