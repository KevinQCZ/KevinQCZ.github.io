import type { AdminSession, ArticleSeed } from './article-editor-types';

interface EditorModule {
  mountArticleEditorUi: (
    root: HTMLElement,
    apiOrigin: string,
    seed: ArticleSeed,
    session: AdminSession,
    fetcher: typeof fetch
  ) => Promise<void>;
}

interface Dependencies {
  fetcher?: typeof fetch;
  loadEditor?: () => Promise<EditorModule>;
}

function isArticleSeed(value: unknown): value is ArticleSeed {
  if (!value || typeof value !== 'object') return false;
  const seed = value as Partial<ArticleSeed>;
  return typeof seed.permalink === 'string' &&
    typeof seed.sourceFormat === 'string' && ['md', 'mdx'].includes(seed.sourceFormat) &&
    typeof seed.title === 'string' && typeof seed.description === 'string' &&
    typeof seed.publishedAt === 'string' && Array.isArray(seed.categories) &&
    seed.categories.every((item) => typeof item === 'string') &&
    Array.isArray(seed.tags) && seed.tags.every((item) => typeof item === 'string') &&
    (seed.coverUrl === null || typeof seed.coverUrl === 'string') &&
    typeof seed.body === 'string';
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

  let seed: unknown;
  try {
    seed = JSON.parse(root.dataset.articleSeed || '');
  } catch {
    return;
  }
  if (!isArticleSeed(seed)) return;

  try {
    const response = await fetcher(`${apiOrigin}/api/me`, { credentials: 'include' });
    if (!response.ok) return;
    const session = await response.json();
    if (!isAdminSession(session)) return;
    const editor = await loadEditor();
    await editor.mountArticleEditorUi(root, apiOrigin, seed, session, fetcher);
  } catch {
    // Public article rendering remains available when the admin service is not.
  }
}
