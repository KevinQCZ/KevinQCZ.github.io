import type { EditorView } from 'codemirror';
import { isSafeCoverUrl, renderSafeMarkdown } from './editor-preview';
import type { AdminSession, ArticleDraft, ArticleSeed, DraftPayload } from './article-editor-types';
import '../styles/article-editor.css';

type EditorContent = Omit<ArticleSeed, 'permalink'>;

function isArticleDraft(value: unknown, permalink: string): value is ArticleDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ArticleDraft>;
  return draft.permalink === permalink && ['md', 'mdx'].includes(String(draft.sourceFormat)) &&
    typeof draft.title === 'string' && typeof draft.description === 'string' &&
    typeof draft.publishedAt === 'string' && Array.isArray(draft.categories) &&
    draft.categories.every((item) => typeof item === 'string') &&
    Array.isArray(draft.tags) && draft.tags.every((item) => typeof item === 'string') &&
    (draft.coverUrl === null || typeof draft.coverUrl === 'string') &&
    typeof draft.body === 'string' && Number.isSafeInteger(draft.revision) &&
    typeof draft.createdAt === 'number' && typeof draft.updatedAt === 'number';
}

function contentOf(article: ArticleSeed | ArticleDraft): EditorContent {
  return {
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
  return left.sourceFormat === right.sourceFormat &&
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
    </div>
    <section class="article-editor-panel" data-editor-panel hidden aria-label="Article editor">
      <div class="article-editor-toolbar">
        <p data-editor-status role="status" aria-live="polite"></p>
        <div class="article-editor-actions">
          <button type="button" class="button-secondary" data-preview-action>Preview</button>
          <button type="button" class="button-secondary" data-cancel>Cancel</button>
          <button type="button" class="button-primary" data-save disabled>Save Draft</button>
        </div>
      </div>
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
          <p class="article-editor-permalink">Published URL is fixed: <code data-permalink></code></p>
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
  seed: ArticleSeed,
  session: AdminSession,
  fetcher: typeof fetch = fetch
): Promise<void> {
  root.classList.add('article-editor');
  root.innerHTML = editorMarkup();

  const identity = root.querySelector<HTMLElement>('[data-editor-identity]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-editor-toggle]')!;
  const panel = root.querySelector<HTMLElement>('[data-editor-panel]')!;
  const readMode = root.parentElement?.querySelector<HTMLElement>('[data-article-read-mode]');
  const status = root.querySelector<HTMLElement>('[data-editor-status]')!;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-save]')!;
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

  let baseline = contentOf(seed);
  let revision: number | null = null;
  let editor: EditorView | null = null;
  let editorLoad: Promise<void> | null = null;
  let editorError = false;
  let dirty = false;
  let saving = false;
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

  const refreshDirty = () => {
    dirty = !sameContent(currentContent(), baseline);
    saveButton.disabled = saving || !dirty;
    if (dirty) setStatus('Unsaved changes.');
    else if (!saving) setStatus('No unsaved changes.');
    updatePreview();
  };

  const fill = (content: EditorContent) => {
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

  let loadError: string | null = null;
  try {
    const query = new URLSearchParams({ permalink: seed.permalink });
    const response = await fetcher(`${apiOrigin}/api/admin/drafts?${query}`, { credentials: 'include' });
    if (response.status === 200) {
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' ||
          !('draft' in result) || !isArticleDraft(result.draft, seed.permalink)) {
        throw new Error('Invalid draft response');
      }
      baseline = contentOf(result.draft);
      revision = result.draft.revision;
    } else if (response.status !== 404) {
      throw new Error('Could not load saved draft');
    }
  } catch {
    loadError = 'Could not load the saved draft; your edits will be kept if the request fails.';
  }
  fill(baseline);
  refreshDirty();
  if (loadError) setStatus(loadError, true);

  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]').forEach((input) => {
    input.addEventListener('input', refreshDirty);
    input.addEventListener('change', refreshDirty);
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
    if (!inputs.title.reportValidity() || !inputs.description.reportValidity() ||
        !inputs.publishedAt.reportValidity()) return;
    const current = currentContent();
    if (current.coverUrl && !isSafeCoverUrl(current.coverUrl)) {
      coverError.textContent = 'Enter a valid HTTPS image URL without embedded credentials.';
      inputs.coverUrl.focus();
      setStatus('Fix the cover image URL before saving.', true);
      return;
    }
    const query = new URLSearchParams({ permalink: seed.permalink });
    const payload: DraftPayload = { ...current, permalink: seed.permalink, expectedRevision: revision };
    saving = true;
    saveButton.disabled = true;
    setStatus('Saving draft…');
    try {
      const response = await fetcher(`${apiOrigin}/api/admin/drafts?${query}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(payload)
      });
      if (response.status === 409) {
        setStatus('A newer draft exists. Your edits are still here; copy them before reloading the saved draft.', true);
        return;
      }
      if (!response.ok) throw new Error('Draft save failed');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' ||
          !('draft' in result) || !isArticleDraft(result.draft, seed.permalink)) {
        throw new Error('Invalid saved draft response');
      }
      baseline = contentOf(result.draft);
      revision = result.draft.revision;
      dirty = false;
      saveButton.disabled = true;
      setStatus('Draft saved locally. It has not been published.');
    } catch {
      setStatus('Draft could not be saved. Your edits are still here.', true);
    } finally {
      saving = false;
      saveButton.disabled = !dirty;
    }
  });

  setTab('editor');
}
