import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';

const allowedTags = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
];
const attachmentUrl = /^attachment:([a-f0-9-]{36})$/i;

function isAttachmentLink(value: string | null | undefined, apiOrigin: string): boolean {
  if (!value || !apiOrigin) return false;
  try {
    const url = new URL(value, document.baseURI);
    return url.origin === apiOrigin &&
      /^\/api\/attachments\/[a-f0-9-]{36}\/(?:preview|download)$/.test(url.pathname) &&
      /^a_[A-Za-z0-9_-]{22}$/.test(url.searchParams.get('articleId') || '');
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

export function isSafeCoverUrl(value: string): boolean {
  if (!value || value.length > 2048) return value === '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isSafeLinkUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:#|\/(?!\/)|\.\.?\/|\?)/.test(trimmed)) return true;
  try {
    const url = new URL(trimmed, document.baseURI);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

export function renderSafeMarkdown(
  source: string,
  preview: HTMLElement,
  coverUrl: string | null,
  title: string,
  apiOrigin = ''
): void {
  const renderer = new Renderer();
  renderer.html = ({ text }) => `<pre><code>${escapeHtml(text)}</code></pre>`;
  renderer.image = ({ href, text }) => {
    const attachment = attachmentUrl.exec(href || '');
    return attachment || isAttachmentLink(href, apiOrigin)
      ? `<span class="preview-attachment">[Attachment image: ${escapeHtml(text || 'Image')}]</span>`
      : `<span class="preview-image-placeholder">[Image: ${escapeHtml(text)}]</span>`;
  };
  renderer.link = ({ href, text }) => {
    if (attachmentUrl.test(href || '') || isAttachmentLink(href, apiOrigin)) {
      return `<span class="preview-attachment">[Attachment: ${text}]</span>`;
    }
    return `<a href="${escapeHtml(href || '')}">${text}</a>`;
  };
  const html = marked.parse(source, {
    async: false,
    breaks: false,
    gfm: true,
    renderer
  });
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['href', 'title', 'class'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['img', 'svg', 'math', 'iframe', 'video', 'audio', 'style', 'form', 'input']
  });
  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (!isSafeLinkUrl(anchor.getAttribute('href') || '')) anchor.removeAttribute('href');
  });
  preview.replaceChildren(template.content.cloneNode(true));

  if (coverUrl && isSafeCoverUrl(coverUrl)) {
    const image = document.createElement('img');
    image.src = coverUrl;
    image.alt = title;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.className = 'editor-cover-preview';
    preview.prepend(image);
  }
}
