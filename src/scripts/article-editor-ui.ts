import type { EditorView } from 'codemirror';
import { isSafeCoverUrl, renderSafeMarkdown } from './editor-preview';
import { adminFetch } from './admin-auth';
import type { AdminSession, ArticleContent, ArticleDraft, EditorSeed, DraftPayload } from './article-editor-types';
import '../styles/article-editor.css';

type EditorContent = ArticleContent;

interface AttachmentRecord {
  id: string;
  original_filename: string;
  display_filename: string;
  file_extension: string;
  detected_mime_type: string;
  file_size: number;
  upload_status: 'active';
  visibility: 'private' | 'published';
  created_at: number;
  articleCount?: number;
}

function isAttachmentRecord(value: unknown): value is AttachmentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AttachmentRecord>;
  return typeof record.id === 'string' && /^[a-f0-9-]{36}$/i.test(record.id) &&
    typeof record.original_filename === 'string' && typeof record.display_filename === 'string' &&
    typeof record.file_extension === 'string' && typeof record.detected_mime_type === 'string' &&
    Number.isSafeInteger(record.file_size) && record.file_size! > 0 &&
    record.upload_status === 'active' && ['private', 'published'].includes(String(record.visibility)) &&
    typeof record.created_at === 'number';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function markdownLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

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
      <section class="article-attachments" aria-label="Article attachments">
        <div class="article-attachments-toolbar" role="toolbar" aria-label="Attachment actions">
          <button type="button" class="button-secondary" data-insert-image>Insert image</button>
          <button type="button" class="button-secondary" data-insert-file>Insert file</button>
          <button type="button" class="button-secondary" data-library-toggle aria-expanded="false">Attachment library</button>
          <button type="button" class="button-secondary" data-cancel-upload hidden>Cancel upload</button>
          <button type="button" class="button-secondary" data-retry-upload hidden>Retry failed uploads</button>
          <input type="file" data-file-picker multiple hidden />
          <input type="file" data-replace-picker hidden />
        </div>
        <p data-attachment-status role="status" aria-live="polite"></p>
        <section class="attachment-library" data-attachment-library hidden aria-label="Attachment library">
          <div class="attachment-library-controls">
            <label>Search attachments <input data-library-search type="search" maxlength="100" /></label>
            <label>File type
              <select data-library-type>
                <option value="all">All types</option>
                <option value="image">Images</option>
                <option value="document">Documents</option>
                <option value="pdf">PDF</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </label>
            <label>Uploaded from <input data-library-from type="date" /></label>
            <label>Uploaded through <input data-library-to type="date" /></label>
            <label>Sort
              <select data-library-sort>
                <option value="uploaded">Newest</option>
                <option value="name">Filename</option>
                <option value="size">File size</option>
              </select>
            </label>
          </div>
          <p data-library-summary></p>
          <ul data-library-list></ul>
        </section>
      </section>
      <dialog class="attachment-viewer" data-attachment-viewer aria-label="Attachment viewer">
        <header>
          <div><h2 data-viewer-title></h2><p data-viewer-details></p></div>
          <div>
            <button type="button" class="button-secondary" data-viewer-previous aria-label="Previous attachment">Previous</button>
            <button type="button" class="button-secondary" data-viewer-next aria-label="Next attachment">Next</button>
            <button type="button" class="button-secondary" data-viewer-zoom-out aria-label="Zoom out" hidden>−</button>
            <button type="button" class="button-secondary" data-viewer-zoom-reset aria-label="Reset zoom" hidden>100%</button>
            <button type="button" class="button-secondary" data-viewer-zoom-in aria-label="Zoom in" hidden>+</button>
            <button type="button" class="button-secondary" data-viewer-fullscreen>Fullscreen</button>
            <button type="button" class="button-secondary" data-viewer-download>Download</button>
            <button type="button" class="button-secondary" data-viewer-close>Close</button>
          </div>
        </header>
        <div class="attachment-viewer-content" data-viewer-content></div>
      </dialog>
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
  const filePicker = root.querySelector<HTMLInputElement>('[data-file-picker]')!;
  const replacePicker = root.querySelector<HTMLInputElement>('[data-replace-picker]')!;
  const attachmentStatus = root.querySelector<HTMLElement>('[data-attachment-status]')!;
  const cancelUploadButton = root.querySelector<HTMLButtonElement>('[data-cancel-upload]')!;
  const retryUploadButton = root.querySelector<HTMLButtonElement>('[data-retry-upload]')!;
  const libraryToggle = root.querySelector<HTMLButtonElement>('[data-library-toggle]')!;
  const attachmentLibrary = root.querySelector<HTMLElement>('[data-attachment-library]')!;
  const librarySearch = root.querySelector<HTMLInputElement>('[data-library-search]')!;
  const libraryType = root.querySelector<HTMLSelectElement>('[data-library-type]')!;
  const libraryFrom = root.querySelector<HTMLInputElement>('[data-library-from]')!;
  const libraryTo = root.querySelector<HTMLInputElement>('[data-library-to]')!;
  const librarySort = root.querySelector<HTMLSelectElement>('[data-library-sort]')!;
  const librarySummary = root.querySelector<HTMLElement>('[data-library-summary]')!;
  const libraryList = root.querySelector<HTMLUListElement>('[data-library-list]')!;
  const viewer = root.querySelector<HTMLDialogElement>('[data-attachment-viewer]')!;
  const viewerTitle = root.querySelector<HTMLElement>('[data-viewer-title]')!;
  const viewerDetails = root.querySelector<HTMLElement>('[data-viewer-details]')!;
  const viewerContent = root.querySelector<HTMLElement>('[data-viewer-content]')!;
  const viewerDownload = root.querySelector<HTMLButtonElement>('[data-viewer-download]')!;
  const viewerPrevious = root.querySelector<HTMLButtonElement>('[data-viewer-previous]')!;
  const viewerNext = root.querySelector<HTMLButtonElement>('[data-viewer-next]')!;
  const viewerZoomOut = root.querySelector<HTMLButtonElement>('[data-viewer-zoom-out]')!;
  const viewerZoomReset = root.querySelector<HTMLButtonElement>('[data-viewer-zoom-reset]')!;
  const viewerZoomIn = root.querySelector<HTMLButtonElement>('[data-viewer-zoom-in]')!;
  const viewerFullscreen = root.querySelector<HTMLButtonElement>('[data-viewer-fullscreen]')!;
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
  let uploadController: AbortController | null = null;
  let failedUploads: File[] = [];
  let libraryRecords: AttachmentRecord[] = [];
  let activeViewerRecord: AttachmentRecord | null = null;
  let viewerObjectUrl: string | null = null;
  let viewerImage: HTMLImageElement | null = null;
  let viewerZoom = 1;
  let viewerLoadId = 0;

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

  const currentArticleId = async (): Promise<string> => {
    const slug = currentContent().permalink.split('/').at(-1) || 'new-article';
    const articlePath = seed.articlePath || `src/content/articles/${slug}.${seed.sourceFormat}`;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(articlePath)));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    const hash = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `a_${hash.slice(0, 22)}`;
  };

  const insertAttachmentReference = async (record: AttachmentRecord) => {
    const image = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(record.file_extension);
    const label = markdownLabel(record.display_filename);
    const articleId = await currentArticleId();
    const destination = new URL(
      `/api/attachments/${record.id}/${image ? 'preview' : 'download'}`,
      apiOrigin
    );
    destination.searchParams.set('articleId', articleId);
    const reference = `${image ? '!' : ''}[${label}](${destination.href})`;
    if (editor) {
      const { from, to } = editor.state.selection.main;
      editor.dispatch({
        changes: { from, to, insert: reference },
        selection: { anchor: from + reference.length },
        scrollIntoView: true
      });
      editor.focus();
    } else {
      const from = fallback.selectionStart;
      const to = fallback.selectionEnd;
      fallback.setRangeText(reference, from, to, 'end');
      fallback.focus();
      refreshDirty();
    }
    attachmentStatus.textContent = `Inserted ${record.display_filename}. Save the draft to retain the attachment reference.`;
  };

  const uploadOne = async (file: File, replaceId?: string): Promise<AttachmentRecord> => {
    const endpoint = replaceId
      ? `/api/admin/attachments/${encodeURIComponent(replaceId)}/replace`
      : '/api/admin/attachments/upload';
    const response = await adminFetch(apiOrigin, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-CSRF-Token': session.csrfToken,
        'X-Attachment-Name': encodeURIComponent(file.name),
        'X-Attachment-Type': file.type
      },
      body: file,
      ...(uploadController ? { signal: uploadController.signal } : {})
    }, fetcher, session);
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof result?.error === 'string' ? result.error : 'upload_failed');
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' ||
        !('attachment' in result) || !isAttachmentRecord(result.attachment)) {
      throw new Error('invalid_attachment_response');
    }
    return result.attachment;
  };

  const uploadFiles = async (files: File[], replaceId?: string) => {
    if (!files.length || uploadController) return;
    uploadController = new AbortController();
    cancelUploadButton.hidden = false;
    retryUploadButton.hidden = true;
    failedUploads = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) continue;
      attachmentStatus.textContent = `Uploading ${index + 1} of ${files.length}: ${file.name}`;
      try {
        const record = await uploadOne(file, replaceId);
        if (replaceId) {
          attachmentStatus.textContent = `${record.display_filename} was replaced. Previous file version retained for recovery.`;
          await refreshLibrary();
        } else {
          await insertAttachmentReference(record);
        }
      } catch (cause) {
        failedUploads = files.slice(index);
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          attachmentStatus.textContent = `Upload cancelled. ${failedUploads.length} file(s) can be retried.`;
        } else {
          const reason = cause instanceof Error ? cause.message : 'upload_failed';
          attachmentStatus.textContent = `Upload failed for ${file.name} (${reason}). Your article edits are unchanged.`;
        }
        retryUploadButton.hidden = failedUploads.length === 0;
        break;
      }
    }
    if (!failedUploads.length && !replaceId) {
      attachmentStatus.textContent = `${files.length} attachment(s) uploaded and inserted. Save the draft to keep the references.`;
      await refreshLibrary();
    }
    uploadController = null;
    cancelUploadButton.hidden = true;
  };

  const safeLibraryResponse = (value: unknown): value is { attachments: AttachmentRecord[]; summary: {
    total: number; storage: number; images: number; documents: number; unused: number;
  } } => {
    if (!value || typeof value !== 'object') return false;
    const result = value as { attachments?: unknown; summary?: Record<string, unknown> };
    return Array.isArray(result.attachments) && result.attachments.every(isAttachmentRecord) &&
      !!result.summary && ['total', 'storage', 'images', 'documents', 'unused']
        .every((key) => Number.isSafeInteger(result.summary![key]));
  };

  const refreshLibrary = async () => {
    libraryList.replaceChildren();
    librarySummary.textContent = 'Loading attachments…';
    const params = new URLSearchParams({
      search: librarySearch.value.trim(),
      type: libraryType.value,
      sort: librarySort.value
    });
    if (libraryFrom.value) params.set('from', libraryFrom.value);
    if (libraryTo.value) params.set('to', libraryTo.value);
    if (libraryFrom.value && libraryTo.value && libraryFrom.value > libraryTo.value) {
      librarySummary.textContent = 'The start date must be on or before the end date.';
      return;
    }
    try {
      const response = await adminFetch(apiOrigin, `/api/admin/attachments?${params}`, {}, fetcher, session);
      if (!response.ok) throw new Error('attachment_library_unavailable');
      const result: unknown = await response.json();
      if (!safeLibraryResponse(result)) throw new Error('invalid_attachment_library');
      libraryRecords = result.attachments;
      const summary = result.summary;
      librarySummary.textContent =
        `${summary.total} attachments · ${formatFileSize(summary.storage)} · ${summary.images} images · ` +
        `${summary.documents} documents · ${summary.unused} unused`;
      for (const record of libraryRecords) {
        const item = document.createElement('li');
        item.className = 'attachment-library-item';
        const details = document.createElement('div');
        details.className = 'attachment-library-details';
        const name = document.createElement('strong');
        name.textContent = record.display_filename;
        const metadata = document.createElement('span');
        metadata.textContent = `${record.file_extension.toUpperCase()} · ${formatFileSize(record.file_size)} · ` +
          `${new Date(record.created_at).toLocaleString()} · ${record.visibility}`;
        details.append(name, metadata);
        const actions = document.createElement('div');
        actions.className = 'attachment-library-actions';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'button-secondary';
        addButton.textContent = 'Insert';
        addButton.addEventListener('click', () => void insertAttachmentReference(record));
        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.className = 'button-secondary';
        previewButton.textContent = 'Preview';
        previewButton.addEventListener('click', () => void openViewer(record));
        const renameButton = document.createElement('button');
        renameButton.type = 'button';
        renameButton.className = 'button-secondary';
        renameButton.textContent = 'Rename';
        renameButton.addEventListener('click', () => void renameRecord(record));
        const replaceButton = document.createElement('button');
        replaceButton.type = 'button';
        replaceButton.className = 'button-secondary';
        replaceButton.textContent = 'Replace';
        replaceButton.addEventListener('click', () => {
          replacePicker.dataset.attachmentId = record.id;
          replacePicker.value = '';
          replacePicker.click();
        });
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'button-secondary';
        copyButton.textContent = 'Copy link';
        copyButton.addEventListener('click', () => void copyAttachmentLink(record));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'button-secondary';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', () => void removeRecord(record));
        actions.append(addButton, previewButton, renameButton, replaceButton, copyButton, deleteButton);
        item.append(details, actions);
        libraryList.append(item);
      }
      if (!libraryRecords.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No attachments match this search.';
        libraryList.append(empty);
      }
    } catch (cause) {
      librarySummary.textContent = cause instanceof Error ? cause.message : 'Attachment library unavailable.';
    }
  };

  const showViewerMessage = (message: string) => {
    const text = document.createElement('p');
    text.textContent = message;
    viewerContent.replaceChildren(text);
  };

  const attachmentRead = async (record: AttachmentRecord, mode: 'preview' | 'download') =>
    adminFetch(apiOrigin, `/api/attachments/${encodeURIComponent(record.id)}/${mode}`, {}, fetcher, session);

  const updateViewerControls = () => {
    const index = libraryRecords.findIndex((record) => record.id === activeViewerRecord?.id);
    viewerPrevious.disabled = index <= 0;
    viewerNext.disabled = index < 0 || index >= libraryRecords.length - 1;
    for (const control of [viewerZoomOut, viewerZoomReset, viewerZoomIn]) control.hidden = !viewerImage;
    viewerZoomOut.disabled = viewerZoom <= 0.25;
    viewerZoomIn.disabled = viewerZoom >= 4;
    viewerZoomReset.textContent = `${Math.round(viewerZoom * 100)}%`;
  };

  const setViewerZoom = (value: number) => {
    viewerZoom = Math.min(4, Math.max(0.25, value));
    if (viewerImage) viewerImage.style.transform = `scale(${viewerZoom})`;
    updateViewerControls();
  };

  const openViewer = async (record: AttachmentRecord) => {
    const loadId = ++viewerLoadId;
    activeViewerRecord = record;
    viewerImage = null;
    setViewerZoom(1);
    viewerTitle.textContent = record.display_filename;
    viewerDetails.textContent = `${record.file_extension.toUpperCase()} · ${formatFileSize(record.file_size)}`;
    viewerContent.replaceChildren();
    if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
    viewerObjectUrl = null;
    updateViewerControls();
    if (!viewer.open) viewer.showModal();
    try {
      const response = await attachmentRead(record, 'preview');
      if (!response.ok) throw new Error('Attachment preview is unavailable.');
      const blob = await response.blob();
      if (loadId !== viewerLoadId || !viewer.open) return;
      if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
      viewerObjectUrl = URL.createObjectURL(blob);
      const mime = response.headers.get('Content-Type') || '';
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
        const image = document.createElement('img');
        image.src = viewerObjectUrl;
        image.alt = record.display_filename;
        viewerImage = image;
        setViewerZoom(1);
        viewerContent.replaceChildren(image);
      } else if (mime === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = viewerObjectUrl;
        frame.title = `PDF preview: ${record.display_filename}`;
        frame.referrerPolicy = 'no-referrer';
        viewerContent.replaceChildren(frame);
      } else if (['text/plain', 'text/markdown'].includes(mime)) {
        const content = document.createElement('pre');
        content.textContent = await blob.text();
        viewerContent.replaceChildren(content);
      } else if (mime === 'text/csv') {
        renderCsv(await blob.text(), viewerContent);
      } else if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = viewerObjectUrl;
        viewerContent.replaceChildren(audio);
      } else if (mime.startsWith('video/')) {
        const video = document.createElement('video');
        video.controls = true;
        video.src = viewerObjectUrl;
        viewerContent.replaceChildren(video);
      } else {
        showViewerMessage('This file type is not previewed in the browser. Download the original to open it safely.');
      }
      updateViewerControls();
    } catch (cause) {
      if (loadId === viewerLoadId && viewer.open) {
        showViewerMessage(cause instanceof Error ? cause.message : 'Attachment preview is unavailable.');
      }
    }
  };

  const moveViewer = (offset: -1 | 1) => {
    const index = libraryRecords.findIndex((record) => record.id === activeViewerRecord?.id);
    const next = libraryRecords[index + offset];
    if (next) void openViewer(next);
  };

  const renderCsv = (source: string, target: HTMLElement) => {
    const table = document.createElement('table');
    for (const line of source.split(/\r?\n/).slice(0, 500)) {
      const row = document.createElement('tr');
      for (const cell of line.split(',').slice(0, 30)) {
        const element = document.createElement('td');
        element.textContent = cell.replace(/^"|"$/g, '').replaceAll('""', '"');
        row.append(element);
      }
      table.append(row);
    }
    target.replaceChildren(table);
  };

  const downloadAttachment = async (record: AttachmentRecord) => {
    try {
      const response = await attachmentRead(record, 'download');
      if (!response.ok) throw new Error('Attachment download is unavailable.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = record.display_filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      attachmentStatus.textContent = cause instanceof Error ? cause.message : 'Download failed.';
    }
  };

  const renameRecord = async (record: AttachmentRecord) => {
    const displayFilename = window.prompt('Display filename', record.display_filename);
    if (displayFilename === null || displayFilename.trim() === record.display_filename) return;
    try {
      const response = await adminFetch(apiOrigin, `/api/admin/attachments/${encodeURIComponent(record.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ displayFilename })
      }, fetcher, session);
      if (!response.ok) throw new Error('Attachment could not be renamed.');
      attachmentStatus.textContent = 'Attachment display name updated.';
      await refreshLibrary();
    } catch (cause) {
      attachmentStatus.textContent = cause instanceof Error ? cause.message : 'Rename failed.';
    }
  };

  const removeRecord = async (record: AttachmentRecord) => {
    if (!window.confirm(`Permanently delete ${record.display_filename}? This cannot be undone.`)) return;
    try {
      const response = await adminFetch(apiOrigin, `/api/admin/attachments/${encodeURIComponent(record.id)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': session.csrfToken }
      }, fetcher, session);
      if (response.status === 409) throw new Error('Remove this attachment from every saved or published article before deleting it.');
      if (!response.ok) throw new Error('Attachment could not be deleted.');
      attachmentStatus.textContent = 'Attachment deleted.';
      await refreshLibrary();
    } catch (cause) {
      attachmentStatus.textContent = cause instanceof Error ? cause.message : 'Delete failed.';
    }
  };

  const copyAttachmentLink = async (record: AttachmentRecord) => {
    try {
      const articleId = await currentArticleId();
      const link = new URL(`/api/attachments/${record.id}/download`, apiOrigin);
      link.searchParams.set('articleId', articleId);
      await navigator.clipboard.writeText(link.href);
      attachmentStatus.textContent = 'Attachment link copied. It becomes publicly readable only after its article is published.';
    } catch {
      attachmentStatus.textContent = 'Could not copy the attachment link.';
    }
  };

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
    renderSafeMarkdown(current.body, previewBody, safeCover, current.title, apiOrigin);
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
  root.querySelector<HTMLButtonElement>('[data-insert-image]')!.addEventListener('click', () => {
    filePicker.accept = 'image/*';
    filePicker.value = '';
    filePicker.click();
  });
  root.querySelector<HTMLButtonElement>('[data-insert-file]')!.addEventListener('click', () => {
    filePicker.accept = '';
    filePicker.value = '';
    filePicker.click();
  });
  filePicker.addEventListener('change', () => {
    if (filePicker.files?.length) void uploadFiles(Array.from(filePicker.files));
    filePicker.value = '';
  });
  replacePicker.addEventListener('change', () => {
    const file = replacePicker.files?.[0];
    const attachmentId = replacePicker.dataset.attachmentId;
    delete replacePicker.dataset.attachmentId;
    if (file && attachmentId) void uploadFiles([file], attachmentId);
  });
  cancelUploadButton.addEventListener('click', () => uploadController?.abort());
  retryUploadButton.addEventListener('click', () => {
    const retry = [...failedUploads];
    failedUploads = [];
    void uploadFiles(retry);
  });
  libraryToggle.addEventListener('click', () => {
    const opening = attachmentLibrary.hidden;
    attachmentLibrary.hidden = !opening;
    libraryToggle.setAttribute('aria-expanded', String(opening));
    if (opening) void refreshLibrary();
  });
  let searchTimer: number | undefined;
  librarySearch.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void refreshLibrary(), 250);
  });
  libraryType.addEventListener('change', () => void refreshLibrary());
  libraryFrom.addEventListener('change', () => void refreshLibrary());
  libraryTo.addEventListener('change', () => void refreshLibrary());
  librarySort.addEventListener('change', () => void refreshLibrary());
  root.querySelector<HTMLButtonElement>('[data-viewer-close]')!.addEventListener('click', () => viewer.close());
  viewerPrevious.addEventListener('click', () => moveViewer(-1));
  viewerNext.addEventListener('click', () => moveViewer(1));
  viewerZoomOut.addEventListener('click', () => setViewerZoom(viewerZoom / 1.25));
  viewerZoomReset.addEventListener('click', () => setViewerZoom(1));
  viewerZoomIn.addEventListener('click', () => setViewerZoom(viewerZoom * 1.25));
  viewerFullscreen.disabled = typeof viewer.requestFullscreen !== 'function';
  viewerFullscreen.addEventListener('click', () => {
    const change = document.fullscreenElement === viewer
      ? document.exitFullscreen()
      : viewer.requestFullscreen();
    void change.catch(() => {
      attachmentStatus.textContent = 'Fullscreen mode could not be opened.';
    });
  });
  document.addEventListener('fullscreenchange', () => {
    viewerFullscreen.textContent = document.fullscreenElement === viewer ? 'Exit fullscreen' : 'Fullscreen';
  });
  viewer.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') moveViewer(-1);
    if (event.key === 'ArrowRight') moveViewer(1);
  });
  viewer.addEventListener('close', () => {
    viewerLoadId += 1;
    viewerContent.replaceChildren();
    if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
    viewerObjectUrl = null;
    viewerImage = null;
    activeViewerRecord = null;
    updateViewerControls();
  });
  viewerDownload.addEventListener('click', () => {
    if (activeViewerRecord) void downloadAttachment(activeViewerRecord);
  });
  root.addEventListener('drop', (event) => {
    if (!(event.target instanceof Node) ||
        !sourceHost.contains(event.target) && !fallback.contains(event.target)) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void uploadFiles(files);
  });
  root.addEventListener('dragover', (event) => {
    if (!(event.target instanceof Node) ||
        !sourceHost.contains(event.target) && !fallback.contains(event.target)) return;
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
  });
  root.addEventListener('paste', (event) => {
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!imageFiles.length) return;
    event.preventDefault();
    void uploadFiles(imageFiles);
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
