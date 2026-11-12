import type { EditorView } from 'codemirror';
import { isSafeCoverUrl, renderSafeMarkdown } from './editor-preview';
import { adminFetch } from './admin-auth';
import type { AdminSession, ArticleContent, ArticleDraft, EditorSeed, DraftPayload } from './article-editor-types';
import '../styles/article-editor.css';

type EditorContent = ArticleContent;

function isArticleDraft(value: unknown, permalink: string): value is ArticleDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ArticleDraft>;
  return typeof draft.id === 'string' && /^d_[a-f0-9-]{32,36}$/i.test(draft.id) &&
    (draft.articlePath === null || typeof draft.articlePath === 'string') &&
    (draft.baseSha === null || typeof draft.baseSha === 'string') &&
    ['DRAFT', 'PENDING_PUBLICATION'].includes(String(draft.status)) && draft.permalink === permalink &&
    ['md', 'mdx'].includes(String(draft.sourceFormat)) &&
    typeof draft.title === 'string' && typeof draft.description === 'string' &&
    typeof draft.publishedAt === 'string' && Array.isArray(draft.categories) &&
    draft.categories.every((item) => typeof item === 'string') &&
    Array.isArray(draft.tags) && draft.tags.every((item) => typeof item === 'string') &&
    (draft.coverUrl === null || typeof draft.coverUrl === 'string') &&
    typeof draft.body === 'string' && Number.isSafeInteger(draft.revision) &&
    typeof draft.createdAt === 'number' && typeof draft.updatedAt === 'number' &&
    ['NOT_SUBMITTED', 'OPEN', 'CLOSED', 'MERGED'].includes(String(draft.publicationState)) &&
    (draft.pullRequestNumber === null || Number.isSafeInteger(draft.pullRequestNumber)) &&
    (draft.pullRequestUrl === null || typeof draft.pullRequestUrl === 'string') &&
    (draft.submittedRevision === null || Number.isSafeInteger(draft.submittedRevision));
}

function safePullRequestUrl(value: unknown, number: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' &&
      url.pathname === `/KevinQCZ/KevinQCZ.github.io/pull/${number}` &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function contentOf(article: EditorSeed | ArticleDraft): EditorContent {
  return {
    permalink: article.permalink,
    sourceFormat: article.sourceFormat,
    title: article.title,
    description: article.description,
    publishedAt: article.publishedAt,
    categories: [...article.categories],
    tags: [...article.tags],
    coverUrl: article.coverUrl,
    body: article.body
  };
}

function sameContent(left: EditorContent, right: EditorContent): boolean {
  return left.permalink === right.permalink &&
    left.sourceFormat === right.sourceFormat &&
    left.title === right.title &&
    left.description === right.description &&
    left.publishedAt === right.publishedAt &&
    left.coverUrl === right.coverUrl &&
    left.body === right.body &&
    JSON.stringify(left.categories) === JSON.stringify(right.categories) &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags);
}

function labelsFromText(value: string): string[] {
  return value.split('\n').map((label) => label.trim()).filter(Boolean);
}

function editorMarkup(): string {
  return `
    <div class="article-editor-bar">
      <p data-editor-identity></p>
      <button type="button" class="button-secondary" data-editor-toggle aria-expanded="false">Edit article</button>
      <button type="button" class="button-secondary" data-editor-close hidden>Back to drafts</button>
    </div>
    <section class="article-editor-panel" data-editor-panel hidden aria-label="Article editor">
      <div class="article-editor-toolbar">
        <p data-editor-status role="status" aria-live="polite"></p>
        <div class="article-editor-actions">
          <button type="button" class="button-secondary" data-preview-action>Preview</button>
          <button type="button" class="button-secondary" data-cancel>Cancel</button>
          <button type="button" class="button-primary" data-save disabled>Save Draft</button>
          <button type="button" class="button-primary" data-publish disabled>Create pull request</button>
        </div>
      </div>
      <a data-pull-request hidden target="_blank" rel="noopener noreferrer"></a>
      <div class="article-editor-tabs" role="tablist" aria-label="Editor view">
        <button type="button" role="tab" id="editor-tab" aria-controls="editor-tabpanel" aria-selected="true" data-tab="editor">Editor</button>
        <button type="button" role="tab" id="preview-tab" aria-controls="preview-tabpanel" aria-selected="false" data-tab="preview" tabindex="-1">Preview</button>
      </div>
      <div class="article-editor-workspace" data-active-tab="editor">
        <fieldset class="article-editor-metadata" data-metadata>
          <legend>Article metadata</legend>
          <label for="editor-title">Title</label>
          <input id="editor-title" data-field="title" maxlength="200" required />
          <label for="editor-description">Description</label>
          <textarea id="editor-description" data-field="description" maxlength="500" required rows="3"></textarea>
          <label for="editor-published-at">Publication date</label>
          <input id="editor-published-at" data-field="publishedAt" type="date" required />
          <label for="editor-categories">Categories <span>One per line</span></label>
          <textarea id="editor-categories" data-field="categories" rows="3"></textarea>
          <label for="editor-tags">Tags <span>One per line</span></label>
          <textarea id="editor-tags" data-field="tags" rows="3"></textarea>
          <label for="editor-cover">Cover image URL <span>HTTPS only</span></label>
          <input id="editor-cover" data-field="coverUrl" type="url" inputmode="url" maxlength="2048" />
          <p data-cover-error class="article-editor-error" aria-live="polite"></p>
          <label data-permalink-label for="editor-permalink">Permalink</label>
          <input id="editor-permalink" data-permalink-input maxlength="200" pattern="[0-9]{4}/[0-9]{2}/[0-9]{2}/[A-Za-z0-9][A-Za-z0-9-]*" required />
          <p class="article-editor-permalink" data-permalink-fixed hidden>Published URL is fixed: <code data-permalink></code></p>
        </fieldset>
        <section class="article-editor-source" id="editor-tabpanel" role="tabpanel" aria-labelledby="editor-tab" data-source-pane>
          <h2>Markdown / MDX source</h2>
          <div data-code-editor hidden></div>
          <p id="editor-help" class="article-editor-help" role="status" aria-live="polite">MDX source is preserved as text. Components are not executed in preview.</p>
          <textarea data-code-fallback aria-label="Markdown / MDX source" spellcheck="false"></textarea>
        </section>
        <section class="article-editor-preview" id="preview-tabpanel" role="tabpanel" aria-labelledby="preview-tab" data-preview-pane>
          <h2 tabindex="-1">Preview</h2>
          <p class="article-editor-notice">Markdown is previewed safely. MDX, JSX, and custom components are preserved as source and are not executed.</p>
          <div class="article-editor-preview-meta" data-preview-meta></div>
          <div class="article-editor-preview-body article-body" data-preview-body></div>
        </section>
      </div>
    </section>
  `;
}

export async function mountArticleEditorUi(
  root: HTMLElement,
  apiOrigin: string,
  seed: EditorSeed,
  session: AdminSession,
  fetcher: typeof fetch = fetch,
  initialDraft: ArticleDraft | null = null,
  callbacks: { onSaved?: (draft: ArticleDraft) => void; onClose?: () => void } = {}
): Promise<void> {
  root.classList.add('article-editor');
  root.innerHTML = editorMarkup();

  const identity = root.querySelector<HTMLElement>('[data-editor-identity]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-editor-toggle]')!;
  const closeButton = root.querySelector<HTMLButtonElement>('[data-editor-close]')!;
  const panel = root.querySelector<HTMLElement>('[data-editor-panel]')!;
  const readMode = root.parentElement?.querySelector<HTMLElement>('[data-article-read-mode]');
  const status = root.querySelector<HTMLElement>('[data-editor-status]')!;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-save]')!;
  const publishButton = root.querySelector<HTMLButtonElement>('[data-publish]')!;
  const pullRequestLink = root.querySelector<HTMLAnchorElement>('[data-pull-request]')!;
  const cancelButton = root.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const previewButton = root.querySelector<HTMLButtonElement>('[data-preview-action]')!;
  const sourceHost = root.querySelector<HTMLElement>('[data-code-editor]')!;
  const fallback = root.querySelector<HTMLTextAreaElement>('[data-code-fallback]')!;
  const previewBody = root.querySelector<HTMLElement>('[data-preview-body]')!;
  const previewMeta = root.querySelector<HTMLElement>('[data-preview-meta]')!;
  const editorHelp = root.querySelector<HTMLElement>('#editor-help')!;
  const previewPane = root.querySelector<HTMLElement>('[data-preview-pane]')!;
  const workspace = root.querySelector<HTMLElement>('[data-active-tab]')!;
  const coverError = root.querySelector<HTMLElement>('[data-cover-error]')!;
  const permalinkInput = root.querySelector<HTMLInputElement>('[data-permalink-input]')!;
  const permalinkLabel = root.querySelector<HTMLLabelElement>('[data-permalink-label]')!;
  const permalinkFixed = root.querySelector<HTMLElement>('[data-permalink-fixed]')!;
  const readFields = (selector: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${selector}"]`)!;
  const inputs = {
    title: readFields('title') as HTMLInputElement,
    description: readFields('description') as HTMLTextAreaElement,
    publishedAt: readFields('publishedAt') as HTMLInputElement,
    categories: readFields('categories') as HTMLTextAreaElement,
    tags: readFields('tags') as HTMLTextAreaElement,
    coverUrl: readFields('coverUrl') as HTMLInputElement
  };
  root.querySelector<HTMLElement>('[data-permalink]')!.textContent = `/${seed.permalink}/`;
  identity.textContent = `Signed in as ${session.user.githubLogin} (${session.user.role}).`;

  const newArticle = seed.articleId === null && initialDraft === null;
  let baseline = contentOf(initialDraft ?? seed);
  let revision: number | null = initialDraft?.revision ?? null;
  let draftId: string | null = initialDraft?.id ?? null;
  let permalinkEdited = false;
  let editor: EditorView | null = null;
  let editorLoad: Promise<void> | null = null;
  let editorError = false;
  let dirty = false;
  let saving = false;
  let publicationState = initialDraft?.publicationState ?? 'NOT_SUBMITTED';
  let activeTab: 'editor' | 'preview' = 'editor';

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.dataset.error = String(isError);
  };

  const setTab = (tab: 'editor' | 'preview') => {
    activeTab = tab;
    workspace.dataset.activeTab = tab;
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  };

  const bodyValue = () => editor?.state.doc.toString() ?? fallback.value;
  const currentContent = (): EditorContent => ({
    permalink: permalinkInput.value.trim(),
    sourceFormat: seed.sourceFormat,
    title: inputs.title.value,
    description: inputs.description.value,
    publishedAt: inputs.publishedAt.value,
    categories: labelsFromText(inputs.categories.value),
    tags: labelsFromText(inputs.tags.value),
    coverUrl: inputs.coverUrl.value || null,
    body: bodyValue()
  });

  const updatePreview = () => {
    const current = currentContent();
    const safeCover = current.coverUrl && !isSafeCoverUrl(current.coverUrl) ? null : current.coverUrl;
    coverError.textContent = current.coverUrl && !safeCover
      ? 'Enter a valid HTTPS image URL without embedded credentials.'
      : '';
    const heading = document.createElement('h3');
    heading.textContent = current.title || 'Untitled article';
    const description = document.createElement('p');
    description.textContent = current.description;
    const details = document.createElement('p');
    details.textContent = [
      current.publishedAt,
      ...current.categories.map((category) => `Category: ${category}`),
      ...current.tags.map((tag) => `#${tag}`)
    ].filter(Boolean).join(' · ');
    previewMeta.replaceChildren(heading, description, details);
    renderSafeMarkdown(current.body, previewBody, safeCover, current.title);
  };

  const refreshActions = () => {
    saveButton.disabled = saving || !dirty;
    publishButton.disabled = saving || dirty || !draftId || revision === null;
    publishButton.textContent = publicationState === 'OPEN' || publicationState === 'CLOSED'
      ? 'Update pull request'
      : 'Create pull request';
  };

  const refreshDirty = () => {
    dirty = !sameContent(currentContent(), baseline);
    refreshActions();
    if (dirty) setStatus('Unsaved changes.');
    else if (!saving) setStatus('No unsaved changes.');
    updatePreview();
  };

  const updatePublication = (draft: ArticleDraft) => {
    publicationState = draft.publicationState;
    refreshDirty();
    if (draft.pullRequestNumber && safePullRequestUrl(draft.pullRequestUrl, draft.pullRequestNumber)) {
      pullRequestLink.href = draft.pullRequestUrl;
      pullRequestLink.textContent = `View pull request #${draft.pullRequestNumber}`;
      pullRequestLink.hidden = false;
    } else {
      pullRequestLink.removeAttribute('href');
      pullRequestLink.textContent = '';
      pullRequestLink.hidden = true;
    }
  };

  const fill = (content: EditorContent) => {
    permalinkInput.value = content.permalink;
    root.querySelector<HTMLElement>('[data-permalink]')!.textContent = `/${content.permalink}/`;
    inputs.title.value = content.title;
    inputs.description.value = content.description;
    inputs.publishedAt.value = content.publishedAt;
    inputs.categories.value = content.categories.join('\n');
    inputs.tags.value = content.tags.join('\n');
    inputs.coverUrl.value = content.coverUrl ?? '';
    if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content.body } });
    else fallback.value = content.body;
    updatePreview();
  };

  const slugFromTitle = (title: string) => title.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-article';
  const refreshGeneratedPermalink = () => {
    if (!newArticle || draftId || permalinkEdited) return;
    permalinkInput.value = `${inputs.publishedAt.value.replaceAll('-', '/')}/${slugFromTitle(inputs.title.value)}`;
    root.querySelector<HTMLElement>('[data-permalink]')!.textContent = `/${permalinkInput.value}/`;
  };
  if (newArticle) {
    permalinkInput.hidden = false;
    permalinkLabel.hidden = false;
    permalinkFixed.hidden = true;
  } else {
    permalinkInput.hidden = true;
    permalinkLabel.hidden = true;
    permalinkFixed.hidden = false;
  }
  if (callbacks.onClose) closeButton.hidden = false;

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty) return;
    event.preventDefault();
  };

  const initializeEditor = async () => {
    if (editor || editorError) return;
    if (!editorLoad) {
      editorLoad = (async () => {
        try {
          const [{ EditorState }, { basicSetup, EditorView: CodeMirrorView }, { markdown }] =
            await Promise.all([
              import('@codemirror/state'),
              import('codemirror'),
              import('@codemirror/lang-markdown')
            ]);
          editor = new CodeMirrorView({
            parent: sourceHost,
            state: EditorState.create({
              doc: fallback.value,
              extensions: [
                basicSetup,
                markdown(),
                CodeMirrorView.updateListener.of((update) => {
                  if (update.docChanged) refreshDirty();
                })
              ]
            })
          });
          editor.dom.setAttribute('aria-label', 'Markdown / MDX source');
          editor.dom.setAttribute('aria-describedby', 'editor-help');
          sourceHost.hidden = false;
          fallback.hidden = true;
        } catch {
          editorError = true;
          editorHelp.textContent = 'The rich editor could not load; a plain text editor is available.';
        }
      })();
    }
    await editorLoad;
  };

  const setEditing = async (editing: boolean) => {
    panel.hidden = !editing;
    toggle.textContent = editing ? 'Exit edit mode' : 'Edit article';
    toggle.setAttribute('aria-expanded', String(editing));
    if (readMode) readMode.hidden = editing;
    if (!editing) toggle.focus();
    if (editing) {
      setStatus('Loading editor…');
      await initializeEditor();
      if (panel.hidden) return;
      editor?.requestMeasure();
      inputs.title.focus();
      if (status.textContent === 'Loading editor…') {
        setStatus(
          editorError
            ? 'Rich editor unavailable; plain text editor is ready.'
            : dirty ? 'Unsaved changes.' : 'Editing draft.',
          editorError
        );
      }
    }
  };

  fill(baseline);
  refreshDirty();

  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]').forEach((input) => {
    input.addEventListener('input', () => {
      if (newArticle && !draftId && !permalinkEdited &&
          (input === inputs.title || input === inputs.publishedAt)) refreshGeneratedPermalink();
      refreshDirty();
    });
    input.addEventListener('change', () => {
      if (newArticle && !draftId && !permalinkEdited &&
          (input === inputs.title || input === inputs.publishedAt)) refreshGeneratedPermalink();
      refreshDirty();
    });
  });
  permalinkInput.addEventListener('input', () => {
    permalinkEdited = true;
    root.querySelector<HTMLElement>('[data-permalink]')!.textContent = `/${permalinkInput.value}/`;
    refreshDirty();
  });
  fallback.addEventListener('input', refreshDirty);
  window.addEventListener('beforeunload', beforeUnload);
  toggle.addEventListener('click', () => {
    if (panel.hidden) {
      void setEditing(true);
    } else if (!dirty || window.confirm('Discard unsaved article changes?')) {
      fill(baseline);
      refreshDirty();
      void setEditing(false);
    }
  });
  cancelButton.addEventListener('click', () => {
    fill(baseline);
    refreshDirty();
    void setEditing(false);
    setStatus('Changes cancelled.');
  });
  closeButton.addEventListener('click', () => {
    if (dirty && !window.confirm('Discard unsaved article changes and return to drafts?')) return;
    fill(baseline);
    refreshDirty();
    callbacks.onClose?.();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab === 'preview' ? 'preview' : 'editor'));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const next = activeTab === 'editor' ? 'preview' : 'editor';
        setTab(next);
        root.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
      }
    });
  });
  previewButton.addEventListener('click', () => {
    setTab('preview');
    previewPane.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (window.matchMedia('(max-width: 767px)').matches) {
      root.querySelector<HTMLButtonElement>('[data-tab="preview"]')?.focus();
    } else {
      previewPane.querySelector<HTMLElement>('h2')?.focus();
    }
  });

  saveButton.addEventListener('click', async () => {
    if (!dirty || saving) return;
    if (newArticle && !draftId && !permalinkInput.reportValidity()) return;
    if (!inputs.title.reportValidity() || !inputs.description.reportValidity() ||
        !inputs.publishedAt.reportValidity()) return;
    const current = currentContent();
    if (current.coverUrl && !isSafeCoverUrl(current.coverUrl)) {
      coverError.textContent = 'Enter a valid HTTPS image URL without embedded credentials.';
      inputs.coverUrl.focus();
      setStatus('Fix the cover image URL before saving.', true);
      return;
    }
    if (!/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(current.permalink)) {
      setStatus('Use a date-based permalink with a simple slug.', true);
      permalinkInput.focus();
      return;
    }
    const payload: DraftPayload = {
      ...current,
      articleId: draftId ? null : seed.articleId,
      expectedRevision: revision
    };
    saving = true;
    saveButton.disabled = true;
    setStatus('Saving draft…');
    try {
      const response = await adminFetch(
        apiOrigin,
        draftId
          ? `/api/admin/drafts/${encodeURIComponent(draftId)}`
          : '/api/admin/drafts',
        {
        method: draftId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(payload)
        },
        fetcher,
        session
      );
      if (response.status === 409) {
        setStatus('A newer draft exists. Your edits are still here; copy them before reloading the saved draft.', true);
        return;
      }
      if (!response.ok) throw new Error('Draft save failed');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' ||
          !('draft' in result) || !isArticleDraft(result.draft, current.permalink)) {
        throw new Error('Invalid saved draft response');
      }
      baseline = contentOf(result.draft);
      revision = result.draft.revision;
      draftId = result.draft.id;
      updatePublication(result.draft);
      permalinkInput.disabled = true;
      permalinkInput.hidden = true;
      permalinkLabel.hidden = true;
      permalinkFixed.hidden = false;
      root.querySelector<HTMLElement>('[data-permalink]')!.textContent = `/${result.draft.permalink}/`;
      dirty = false;
      saveButton.disabled = true;
      setStatus(`Draft saved locally at ${new Date(result.draft.updatedAt).toLocaleString()}. It has not been published.`);
      callbacks.onSaved?.(result.draft);
    } catch {
      setStatus('Draft could not be saved. Your edits are still here.', true);
    } finally {
      saving = false;
      refreshActions();
    }
  });

  publishButton.addEventListener('click', async () => {
    if (!draftId || revision === null || dirty || saving) return;
    saving = true;
    refreshDirty();
    setStatus('Creating pull request…');
    try {
      const response = await adminFetch(
        apiOrigin,
        `/api/admin/drafts/${encodeURIComponent(draftId)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
          body: JSON.stringify({ expectedRevision: revision })
        },
        fetcher,
        session
      );
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null) as { error?: unknown } | null;
        const message = conflict?.error === 'base_conflict'
          ? 'The published article changed since this draft was started. Reload its current source before creating a pull request.'
          : conflict?.error === 'article_conflict'
            ? 'Another published article uses this path or permalink.'
            : conflict?.error === 'revision_conflict'
              ? 'The draft changed during publication. Refresh the draft list and review the latest revision.'
              : conflict?.error === 'publication_in_progress'
                ? 'A publication request is already in progress.'
                : conflict?.error === 'already_published'
                  ? 'This pull request has already been merged. Refresh the article before editing again.'
                  : 'The draft could not be published because of a conflict.';
        setStatus(message, true);
        return;
      }
      if (!response.ok) throw new Error('Pull request creation failed');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' ||
          !('draft' in result) || !isArticleDraft(result.draft, currentContent().permalink) ||
          !('pullRequest' in result) || !result.pullRequest || typeof result.pullRequest !== 'object') {
        throw new Error('Invalid pull request response');
      }
      const pullRequest = result.pullRequest as { number?: unknown; url?: unknown; state?: unknown };
      if (!Number.isSafeInteger(pullRequest.number) || !safePullRequestUrl(pullRequest.url, pullRequest.number as number) ||
          pullRequest.state !== 'OPEN') throw new Error('Invalid pull request response');
      revision = result.draft.revision;
      baseline = contentOf(result.draft);
      updatePublication(result.draft);
      setStatus(`Pull request #${pullRequest.number} is ready for review. Merge it to publish; this action does not merge it.`);
      callbacks.onSaved?.(result.draft);
    } catch {
      setStatus('The pull request could not be created. Your private draft remains saved.', true);
    } finally {
      saving = false;
      refreshActions();
    }
  });

  if (initialDraft) {
    permalinkInput.disabled = true;
    permalinkInput.hidden = true;
    permalinkLabel.hidden = true;
    permalinkFixed.hidden = false;
    updatePublication(initialDraft);
  }
  setTab('editor');
}
