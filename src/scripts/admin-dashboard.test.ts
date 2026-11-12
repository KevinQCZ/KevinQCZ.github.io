import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initAdminDashboard } from './admin-dashboard';
import type { AdminSession, ArticleDraft, ArticleListEntry, DraftListEntry } from './article-editor-types';

const session: AdminSession = {
  csrfToken: 'csrf-token',
  user: { githubId: '123', githubLogin: 'approved-user', role: 'ADMIN' }
};

const article: ArticleListEntry = {
  id: 'a_1234567890123456789012',
  articlePath: 'src/content/articles/example.mdx',
  sha: 'a'.repeat(40),
  fileName: 'example.mdx'
};

const draft: ArticleDraft = {
  id: 'd_12345678-1234-4234-8234-123456789abc',
  articlePath: 'src/content/articles/example.mdx',
  baseSha: 'a'.repeat(40),
  status: 'DRAFT',
  permalink: '2026/01/01/example',
  sourceFormat: 'mdx',
  title: 'Private draft',
  description: 'Private description',
  publishedAt: '2026-01-01',
  categories: ['Engineering'],
  tags: ['Astro'],
  coverUrl: null,
  body: '# Private source',
  revision: 2,
  createdAt: 100,
  updatedAt: 200
};

const summary: DraftListEntry = {
  id: draft.id,
  articlePath: draft.articlePath,
  baseSha: draft.baseSha,
  status: 'DRAFT',
  permalink: draft.permalink,
  sourceFormat: draft.sourceFormat,
  title: draft.title,
  description: draft.description,
  publishedAt: draft.publishedAt,
  categories: draft.categories,
  tags: draft.tags,
  coverUrl: draft.coverUrl,
  revision: draft.revision,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt
};

function createRoot(): HTMLElement {
  document.body.innerHTML = `
    <div id="admin" data-api-origin="https://api.example.test">
      <p data-status></p>
      <button data-login hidden></button>
      <button data-logout hidden></button>
      <section data-admin-tools hidden>
        <p data-list-status></p>
        <button data-new-article hidden></button>
        <ul data-article-list></ul>
        <ul data-draft-list></ul>
        <div data-editor-host hidden><div data-editor-mount></div></div>
      </section>
    </div>`;
  return document.querySelector<HTMLElement>('#admin')!;
}

describe('admin draft dashboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps guest controls hidden and does not request private article lists', async () => {
    const root = createRoot();
    const fetcher = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    await initAdminDashboard(root, fetcher);
    expect(root.querySelector('[data-login]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-admin-tools]')?.hasAttribute('hidden')).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('lists private drafts, continues editing, and deletes only through the protected API', async () => {
    const root = createRoot();
    let listCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/me')) return Response.json({ authenticated: true, ...session });
      if (url.endsWith('/api/admin/articles')) {
        listCalls += 1;
        const drafts = listCalls === 1 ? [summary] : [];
        return Response.json({
          articles: [article],
          drafts,
          publishedSourceAvailable: true,
          publishedSourceError: null
        });
      }
      if (url.endsWith(`/api/admin/articles/${encodeURIComponent(draft.id)}`)) {
        return Response.json({ draft });
      }
      if (url.endsWith(`/api/admin/drafts/${encodeURIComponent(draft.id)}`) && init?.method === 'DELETE') {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await initAdminDashboard(root, fetcher);
    expect(root.textContent).toContain('example.mdx');
    expect(root.textContent).toContain('Private draft');

    root.querySelector<HTMLButtonElement>('[data-continue-draft]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-editor-toggle]')).not.toBeNull());
    expect(root.querySelector<HTMLTextAreaElement>('[data-code-fallback]')?.value).toBe(draft.body);

    window.confirm = vi.fn(() => true);
    root.querySelector<HTMLButtonElement>('[data-delete-draft]')!.click();
    await vi.waitFor(() => expect(listCalls).toBe(2));
    const deletion = fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deletion?.[0]).toBe(`https://api.example.test/api/admin/drafts/${encodeURIComponent(draft.id)}`);
    expect(deletion?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'X-CSRF-Token': session.csrfToken }),
      body: '{}'
    });
    expect(root.textContent).not.toContain('Private draft');
  });

  it('keeps existing drafts available when published-source access is unavailable', async () => {
    const root = createRoot();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/me')) return Response.json({ authenticated: true, ...session });
      return Response.json({
        articles: [],
        drafts: [summary],
        publishedSourceAvailable: false,
        publishedSourceError: 'unavailable'
      });
    });
    await initAdminDashboard(root, fetcher);
    expect(root.textContent).toContain('Private draft');
    expect(root.textContent).toContain('Published source is unavailable');
    expect(root.querySelector<HTMLButtonElement>('[data-new-article]')?.disabled).toBe(true);
  });
});
