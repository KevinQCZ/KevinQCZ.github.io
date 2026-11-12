import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountArticleEditor } from './article-editor';
import { mountArticleEditorUi } from './article-editor-ui';
import { renderSafeMarkdown } from './editor-preview';
import type { AdminSession, ArticleSeed } from './article-editor-types';

vi.mock('codemirror', () => {
  class UnavailableEditorView {
    static updateListener = { of: () => ({}) };
    constructor() {
      throw new Error('Use the plain-text fallback in this test.');
    }
  }
  return { basicSetup: [], EditorView: UnavailableEditorView };
});

const seed: ArticleSeed = {
  permalink: '2026/01/01/example',
  sourceFormat: 'mdx',
  title: 'Original title',
  description: 'Original description',
  publishedAt: '2026-01-01',
  categories: ['Engineering'],
  tags: ['Astro'],
  coverUrl: null,
  body: '# Original body'
};

const session: AdminSession = {
  csrfToken: 'test-csrf-token',
  user: { githubId: '123', githubLogin: 'approved-user', role: 'ADMIN' }
};

function createRoot(): HTMLElement {
  document.body.innerHTML = '<div data-article-editor></div><div data-article-read-mode>Published article</div>';
  return document.querySelector<HTMLElement>('[data-article-editor]')!;
}

describe('editor authorization bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not load editor controls for a guest', async () => {
    const root = createRoot();
    root.dataset.apiOrigin = 'https://api.example.test';
    root.dataset.articleSeed = JSON.stringify(seed);
    const loadEditor = vi.fn();
    await mountArticleEditor(root, {
      fetcher: vi.fn(async () => Response.json({ authenticated: false }, { status: 401 })),
      loadEditor
    });
    expect(loadEditor).not.toHaveBeenCalled();
    expect(root.querySelector('[data-editor-toggle]')).toBeNull();
  });

  it('loads the editor only for the server-derived ADMIN role', async () => {
    const root = createRoot();
    root.dataset.apiOrigin = 'https://api.example.test';
    root.dataset.articleSeed = JSON.stringify(seed);
    const mountArticleEditorUi = vi.fn();
    await mountArticleEditor(root, {
      fetcher: vi.fn(async () => Response.json({
        authenticated: true,
        user: { githubId: '123', githubLogin: 'approved-user', role: 'ADMIN' },
        csrfToken: 'test-csrf-token'
      })),
      loadEditor: async () => ({ mountArticleEditorUi })
    });
    expect(mountArticleEditorUi).toHaveBeenCalledWith(
      root,
      'https://api.example.test',
      seed,
      expect.objectContaining({ user: expect.objectContaining({ role: 'ADMIN' }) }),
      expect.any(Function)
    );
  });
});

describe('in-page article editor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('tracks changes, safely previews source, warns on exit and restores the draft on cancel', async () => {
    const root = createRoot();
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    await mountArticleEditorUi(root, 'https://api.example.test', seed, session, fetcher);

    const toggle = root.querySelector<HTMLButtonElement>('[data-editor-toggle]')!;
    const panel = root.querySelector<HTMLElement>('[data-editor-panel]')!;
    const readMode = document.querySelector<HTMLElement>('[data-article-read-mode]')!;
    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(readMode.hidden).toBe(true);

    const title = root.querySelector<HTMLInputElement>('[data-field="title"]')!;
    title.value = 'Changed title';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    const source = root.querySelector<HTMLTextAreaElement>('[data-code-fallback]')!;
    expect(source.hidden).toBe(false);
    source.value = '# Changed body\n\n<script>window.injected = true</script>';
    source.dispatchEvent(new Event('input', { bubbles: true }));

    expect(root.querySelector('[data-save]')?.hasAttribute('disabled')).toBe(false);
    expect(root.querySelector('[data-editor-status]')?.textContent).toBe('Unsaved changes.');
    const preview = root.querySelector<HTMLElement>('[data-preview-body]')!;
    expect(preview.textContent).toContain('Changed body');
    expect(preview.querySelector('script')).toBeNull();
    expect(root.querySelector('[data-preview-meta] h3')?.textContent).toBe('Changed title');

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    expect(title.value).toBe(seed.title);
    expect(source.value).toBe(seed.body);
    expect(readMode.hidden).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(root.querySelector('[data-editor-status]')?.textContent).toBe('Changes cancelled.');
  });

  it('requires confirmation before exiting edit mode with unsaved changes', async () => {
    const root = createRoot();
    await mountArticleEditorUi(root, 'https://api.example.test', seed, session, vi.fn(async () =>
      new Response(null, { status: 404 })
    ));
    const toggle = root.querySelector<HTMLButtonElement>('[data-editor-toggle]')!;
    toggle.click();
    const title = root.querySelector<HTMLInputElement>('[data-field="title"]')!;
    title.value = 'Changed title';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    window.confirm = vi.fn().mockReturnValue(false);
    const confirm = vi.spyOn(window, 'confirm');
    toggle.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLElement>('[data-editor-panel]')?.hidden).toBe(false);
    expect(title.value).toBe('Changed title');

    confirm.mockReturnValue(true);
    toggle.click();
    expect(root.querySelector<HTMLElement>('[data-editor-panel]')?.hidden).toBe(true);
    expect(title.value).toBe(seed.title);
    confirm.mockRestore();
  });

  it('saves only a local draft and retains server revision metadata', async () => {
    const root = createRoot();
    let savedPayload: Record<string, unknown> | null = null;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(null, { status: 404 });
      savedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        draft: {
          ...savedPayload,
          revision: 1,
          createdAt: 100,
          updatedAt: 100
        }
      });
    });
    await mountArticleEditorUi(root, 'https://api.example.test', seed, session, fetcher);

    const title = root.querySelector<HTMLInputElement>('[data-field="title"]')!;
    title.value = 'Saved title';
    const description = root.querySelector<HTMLTextAreaElement>('[data-field="description"]')!;
    description.value = 'Saved description';
    const publishedAt = root.querySelector<HTMLInputElement>('[data-field="publishedAt"]')!;
    publishedAt.value = '2026-02-02';
    const categories = root.querySelector<HTMLTextAreaElement>('[data-field="categories"]')!;
    categories.value = 'Engineering\nEditorial';
    const tags = root.querySelector<HTMLTextAreaElement>('[data-field="tags"]')!;
    tags.value = 'Astro\nMDX';
    const coverUrl = root.querySelector<HTMLInputElement>('[data-field="coverUrl"]')!;
    coverUrl.value = 'https://images.example.test/cover.png';
    [title, description, publishedAt, categories, tags, coverUrl].forEach((input) =>
      input.dispatchEvent(new Event('input', { bubbles: true }))
    );
    root.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await vi.waitFor(() => expect(savedPayload).not.toBeNull());
    await vi.waitFor(() => expect(root.querySelector('[data-editor-status]')?.textContent)
      .toBe('Draft saved locally. It has not been published.'));

    expect(savedPayload).toMatchObject({
      permalink: seed.permalink,
      expectedRevision: null,
      title: 'Saved title',
      description: 'Saved description',
      publishedAt: '2026-02-02',
      categories: ['Engineering', 'Editorial'],
      tags: ['Astro', 'MDX'],
      coverUrl: 'https://images.example.test/cover.png',
      body: seed.body
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      headers: expect.objectContaining({ 'X-CSRF-Token': session.csrfToken })
    });
    expect(root.querySelector('[data-save]')?.hasAttribute('disabled')).toBe(true);
  });

  it('keeps edits and reports a clear error when the draft API fails', async () => {
    const root = createRoot();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'service_unavailable' }, { status: 503 })
        : Response.json({ error: 'service_unavailable' }, { status: 503 })
    );
    await mountArticleEditorUi(root, 'https://api.example.test', seed, session, fetcher);
    expect(root.querySelector('[data-editor-status]')?.textContent).toContain('Could not load the saved draft');

    root.querySelector<HTMLButtonElement>('[data-editor-toggle]')!.click();
    const title = root.querySelector<HTMLInputElement>('[data-field="title"]')!;
    title.value = 'Unsaved title';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-editor-status]')?.textContent)
      .toBe('Draft could not be saved. Your edits are still here.'));
    expect(title.value).toBe('Unsaved title');
    expect(root.querySelector('[data-save]')?.hasAttribute('disabled')).toBe(false);
  });
});

describe('safe Markdown preview', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not execute raw HTML or remote Markdown images and allows only safe cover URLs', () => {
    const preview = document.createElement('div');
    renderSafeMarkdown(
      '<script>alert(1)</script>\n\n![remote](https://tracker.example/image.png)\n\n[bad](javascript:alert(1))',
      preview,
      'javascript:alert(1)',
      'Test'
    );
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(preview.textContent).toContain('<script>');
    expect(preview.textContent).toContain('[Image: remote]');
  });
});
