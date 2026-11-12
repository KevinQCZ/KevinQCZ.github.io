import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';

const allowedTags = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
];

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
  title: string
): void {
  const renderer = new Renderer();
  renderer.html = ({ text }) => `<pre><code>${escapeHtml(text)}</code></pre>`;
  renderer.image = ({ text }) => `<span class="preview-image-placeholder">[Image: ${escapeHtml(text)}]</span>`;
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
