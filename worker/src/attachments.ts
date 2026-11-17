import {
  getPublishedArticle,
  publishedArticlesReferencingAttachment,
  type GitHubAppConfig
} from './github';

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 180;
const ALLOWED_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm'
};
const INLINE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'audio/mpeg', 'audio/wav',
  'video/mp4', 'video/webm'
]);
const encoder = new TextEncoder();

export interface AttachmentEnv {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  MAX_ATTACHMENT_BYTES?: string;
  MAX_ATTACHMENT_STORAGE_BYTES?: string;
}

export interface AttachmentConfig {
  githubApp: GitHubAppConfig | null;
  apiOrigin: string;
}

export interface AttachmentAuth {
  githubUserId: string;
}

interface AttachmentRow {
  id: string;
  original_filename: string;
  display_filename: string;
  file_extension: string;
  detected_mime_type: string;
  declared_mime_type: string;
  file_size: number;
  r2_object_key: string;
  checksum_sha256: string;
  uploaded_by: string;
  upload_status: 'uploading' | 'active' | 'failed' | 'deleted';
  visibility: 'private' | 'published';
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function json(status: number, body: object, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}

function error(status: number, code: string): Response {
  return json(status, { error: code });
}

function configuredLimit(value: string | undefined, fallback: number, maximum: number): number {
  if (!value) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid attachment limit configuration');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error('Invalid attachment limit configuration');
  }
  return parsed;
}

function limits(env: AttachmentEnv): { fileBytes: number; storageBytes: number } {
  return {
    fileBytes: configuredLimit(env.MAX_ATTACHMENT_BYTES, DEFAULT_MAX_FILE_BYTES, 100 * 1024 * 1024),
    storageBytes: configuredLimit(env.MAX_ATTACHMENT_STORAGE_BYTES, DEFAULT_MAX_STORAGE_BYTES, 1024 ** 4)
  };
}

function filenameFromHeader(value: string | null): string | null {
  if (!value || value.length > MAX_FILENAME_LENGTH * 3) return null;
  let name: string;
  try {
    name = decodeURIComponent(value).normalize('NFC').trim();
  } catch {
    return null;
  }
  if (!name || name.length > MAX_FILENAME_LENGTH || /[\/\\\u0000-\u001f\u007f]/.test(name) ||
      name === '.' || name === '..') return null;
  return name;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : null;
}

function declaredTypeAllowed(declared: string, detected: string): boolean {
  const value = declared.trim().toLowerCase().split(';', 1)[0];
  if (!value || value === 'application/octet-stream') return true;
  if (value === detected) return true;
  return detected === 'text/markdown' && value === 'text/plain' ||
    detected === 'audio/wav' && value === 'audio/x-wav';
}

function matchesSignature(extension: string, bytes: Uint8Array): boolean {
  const startsWith = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(start, start + length));
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'gif':
      return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    case 'webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
    case 'pdf':
      return ascii(0, 5) === '%PDF-';
    case 'zip':
      return startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06);
    case 'docx':
    case 'xlsx':
    case 'pptx': {
      if (!startsWith(0x50, 0x4b, 0x03, 0x04)) return false;
      const archive = new TextDecoder().decode(bytes);
      const mainPart = extension === 'docx' ? 'word/document.xml'
        : extension === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
      return archive.includes('[Content_Types].xml') && archive.includes(mainPart);
    }
    case 'mp3':
      return ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case 'wav':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
    case 'mp4':
      return ascii(4, 4) === 'ftyp';
    case 'webm':
      return startsWith(0x1a, 0x45, 0xdf, 0xa3);
    case 'svg': {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source) &&
        !/<(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:|<!ENTITY|<\?xml-stylesheet/i.test(source);
    }
    case 'txt':
    case 'md':
    case 'csv': {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !source.includes('\0');
    }
    default:
      return false;
  }
}

async function readUpload(request: Request, env: AttachmentEnv): Promise<{
  filename: string;
  extension: string;
  declared: string;
  mime: string;
  bytes: Uint8Array;
  checksum: string;
} | Response> {
  const maxBytes = limits(env).fileBytes;
  const filename = filenameFromHeader(request.headers.get('X-Attachment-Name'));
  const extension = filename ? extensionOf(filename) : null;
  const declared = request.headers.get('X-Attachment-Type') || '';
  const contentLength = request.headers.get('Content-Length');
  if (!filename || !extension || !ALLOWED_MIME_TYPES[extension] ||
      declared.length > 120 || contentLength !== null &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    return error(400, 'invalid_file');
  }
  if (!request.body) return error(400, 'missing_file');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return error(413, 'file_too_large');
      }
      chunks.push(value);
    }
  } catch {
    return error(400, 'upload_interrupted');
  }
  if (total === 0 || contentLength !== null && Number(contentLength) !== total) {
    return error(400, 'invalid_file_size');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mime = ALLOWED_MIME_TYPES[extension];
  let signatureMatches = false;
  try {
    signatureMatches = matchesSignature(extension, bytes);
  } catch {
    signatureMatches = false;
  }
  if (!signatureMatches || !declaredTypeAllowed(declared, mime)) {
    return error(415, 'file_type_mismatch');
  }
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  return { filename, extension, declared, mime, bytes, checksum };
}

function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function safeAttachment(row: AttachmentRow) {
  const {
    r2_object_key: _objectKey,
    uploaded_by: _uploadedBy,
    deleted_at: _deletedAt,
    ...publicRecord
  } = row;
  return {
    ...publicRecord,
    uploadedAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function uploadAttachment(
  request: Request,
  env: AttachmentEnv,
  userId: string
): Promise<Response> {
  const file = await readUpload(request, env);
  if (file instanceof Response) return file;
  const { storageBytes } = limits(env);
  const id = crypto.randomUUID();
  const key = `attachments/${id}/${token()}`;
  const now = Date.now();
  const reservation = await env.DB.prepare(
    `INSERT INTO attachments
     (id, original_filename, display_filename, file_extension, detected_mime_type,
      declared_mime_type, file_size, r2_object_key, checksum_sha256, uploaded_by,
      upload_status, visibility, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 'private', ?, ?
     WHERE COALESCE((SELECT SUM(file_size) FROM attachments
       WHERE upload_status IN ('uploading', 'active')), 0) + ? <= ?`
  ).bind(id, file.filename, file.filename, file.extension, file.mime, file.declared,
    file.bytes.byteLength, key, file.checksum, userId, now, now, file.bytes.byteLength,
    storageBytes).run();
  if (reservation.meta.changes !== 1) return error(413, 'storage_quota_exceeded');
  try {
    const data = new ArrayBuffer(file.bytes.byteLength);
    new Uint8Array(data).set(file.bytes);
    await env.ATTACHMENTS.put(key, data, { httpMetadata: { contentType: file.mime } });
    const [active] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE attachments SET upload_status = 'active', updated_at = ?
         WHERE id = ? AND upload_status = 'uploading'`
      ).bind(Date.now(), id),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, github_user_id, action, created_at, result, resource_type, resource_id)
         SELECT ?, ?, 'attachment.upload', ?, 'success', 'attachment', ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), userId, Date.now(), id)
    ]);
    if (active.meta.changes !== 1) throw new Error('Attachment activation failed');
  } catch {
    await env.ATTACHMENTS.delete(key).catch(() => undefined);
    await env.DB.prepare(
      `UPDATE attachments SET upload_status = 'failed', updated_at = ? WHERE id = ?`
    ).bind(Date.now(), id).run();
    return error(503, 'attachment_storage_failed');
  }
  const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?')
    .bind(id).first<AttachmentRow>();
  return row ? json(201, { attachment: safeAttachment(row) }) : error(503, 'attachment_save_failed');
}

export async function listAttachments(request: Request, env: AttachmentEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = (url.searchParams.get('search') || '').trim().slice(0, 100);
  const extension = (url.searchParams.get('type') || '').toLowerCase();
  const articleId = url.searchParams.get('articleId');
  const sort = url.searchParams.get('sort') || 'uploaded';
  const groups: Record<string, string[]> = {
    image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'],
    document: ['pdf', 'txt', 'md', 'csv', 'docx', 'xlsx', 'pptx', 'zip'],
    pdf: ['pdf'],
    audio: ['mp3', 'wav'],
    video: ['mp4', 'webm']
  };
  if (!['name', 'size', 'uploaded'].includes(sort)) return error(400, 'invalid_sort');
  const orderBy = sort === 'name' ? 'a.display_filename COLLATE NOCASE'
    : sort === 'size' ? 'a.file_size'
      : 'a.created_at';
  const direction = url.searchParams.get('direction') === 'asc' ? 'ASC' : 'DESC';
  const clauses = ["a.upload_status = 'active'"];
  const values: Array<string | number> = [];
  if (search) {
    clauses.push('instr(lower(a.display_filename), lower(?)) > 0');
    values.push(search);
  }
  if (extension && extension !== 'all') {
    const extensions = groups[extension] ?? (Object.hasOwn(ALLOWED_MIME_TYPES, extension) ? [extension] : null);
    if (!extensions) return error(400, 'invalid_file_type');
    clauses.push(`a.file_extension IN (${extensions.map(() => '?').join(',')})`);
    values.push(...extensions);
  }
  if (articleId) {
    if (!/^a_[A-Za-z0-9_-]{22}$/.test(articleId)) return error(400, 'invalid_article_id');
    clauses.push('EXISTS (SELECT 1 FROM article_attachments aa WHERE aa.attachment_id = a.id AND aa.article_id = ?)');
    values.push(articleId);
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  if (from && !validDate(from)) return error(400, 'invalid_date');
  if (to && !validDate(to)) return error(400, 'invalid_date');
  if (from) {
    const timestamp = Date.parse(`${from}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp)) return error(400, 'invalid_date');
    clauses.push('a.created_at >= ?');
    values.push(timestamp);
  }
  if (to) {
    const timestamp = Date.parse(`${to}T23:59:59.999Z`);
    if (!Number.isFinite(timestamp)) return error(400, 'invalid_date');
    clauses.push('a.created_at <= ?');
    values.push(timestamp);
  }
  const where = clauses.join(' AND ');
  const [records, aggregates] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM article_attachments aa WHERE aa.attachment_id = a.id) AS article_count
       FROM attachments a WHERE ${where} ORDER BY ${orderBy} ${direction} LIMIT 200`
    ).bind(...values).all<AttachmentRow & { article_count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
       COALESCE(SUM(file_size), 0) AS storage,
       COALESCE(SUM(CASE WHEN file_extension IN ('jpg','jpeg','png','gif','webp','svg') THEN 1 ELSE 0 END), 0) AS images,
       COALESCE(SUM(CASE WHEN file_extension NOT IN ('jpg','jpeg','png','gif','webp','svg') THEN 1 ELSE 0 END), 0) AS documents,
       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM article_attachments aa WHERE aa.attachment_id = attachments.id)
         THEN 1 ELSE 0 END) AS unused
       FROM attachments WHERE upload_status = 'active'`
    ).first<{ total: number; storage: number; images: number; documents: number; unused: number }>()
  ]);
  return json(200, {
    attachments: records.results.map((record) => ({ ...safeAttachment(record), articleCount: record.article_count })),
    summary: aggregates ?? { total: 0, storage: 0, images: 0, documents: 0, unused: 0 }
  });
}

export async function getAttachment(request: Request, env: AttachmentEnv, id: string): Promise<Response> {
  if (!validAttachmentId(id)) return error(404, 'not_found');
  const row = await env.DB.prepare(
    `SELECT * FROM attachments WHERE id = ? AND upload_status = 'active'`
  ).bind(id).first<AttachmentRow>();
  return row ? json(200, { attachment: safeAttachment(row) }) : error(404, 'not_found');
}

export async function renameAttachment(
  request: Request,
  env: AttachmentEnv,
  userId: string,
  id: string,
  payload: unknown
): Promise<Response> {
  if (!validAttachmentId(id) || !payload || typeof payload !== 'object') return error(400, 'invalid_attachment');
  const displayName = (payload as { displayFilename?: unknown }).displayFilename;
  if (typeof displayName !== 'string') return error(400, 'invalid_filename');
  const cleaned = filenameFromHeader(encodeURIComponent(displayName));
  if (!cleaned) return error(400, 'invalid_filename');
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE attachments SET display_filename = ?, updated_at = ?
       WHERE id = ? AND upload_status = 'active'`
    ).bind(cleaned, Date.now(), id),
    env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id)
       SELECT ?, ?, 'attachment.rename', ?, 'success', 'attachment', ? WHERE changes() = 1`
    ).bind(crypto.randomUUID(), userId, Date.now(), id)
  ]);
  if (updated.meta.changes !== 1) return error(404, 'not_found');
  return getAttachment(request, env, id);
}

export async function replaceAttachment(
  request: Request,
  env: AttachmentEnv,
  userId: string,
  id: string
): Promise<Response> {
  if (!validAttachmentId(id)) return error(404, 'not_found');
  const file = await readUpload(request, env);
  if (file instanceof Response) return file;
  const previous = await env.DB.prepare(
    `SELECT * FROM attachments WHERE id = ? AND upload_status = 'active'`
  ).bind(id).first<AttachmentRow>();
  if (!previous) return error(404, 'not_found');
  if (file.extension !== previous.file_extension) return error(400, 'replacement_type_mismatch');
  const maxStorageBytes = limits(env).storageBytes;
  const quota = await env.DB.prepare(
    `SELECT COALESCE(SUM(file_size), 0) - ? + ? AS projected
     FROM attachments WHERE upload_status IN ('uploading', 'active')`
  ).bind(previous.file_size, file.bytes.byteLength).first<{ projected: number }>();
  if (!quota || quota.projected > maxStorageBytes) return error(413, 'storage_quota_exceeded');
  const key = `attachments/${id}/${token()}`;
  const data = new ArrayBuffer(file.bytes.byteLength);
  new Uint8Array(data).set(file.bytes);
  try {
    await env.ATTACHMENTS.put(key, data, { httpMetadata: { contentType: file.mime } });
    const now = Date.now();
    const [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE attachments SET original_filename = ?, display_filename = ?, detected_mime_type = ?,
         declared_mime_type = ?, file_size = ?, r2_object_key = ?, checksum_sha256 = ?, visibility = 'private',
         updated_at = ? WHERE id = ? AND upload_status = 'active'
         AND COALESCE((SELECT SUM(file_size) FROM attachments
           WHERE upload_status IN ('uploading', 'active')), 0) - file_size + ? <= ?`
      ).bind(file.filename, file.filename, file.mime, file.declared, file.bytes.byteLength,
        key, file.checksum, now, id, file.bytes.byteLength, maxStorageBytes),
      env.DB.prepare(
        `INSERT INTO attachment_revisions
         (id, attachment_id, previous_object_key, new_object_key, previous_checksum, new_checksum, changed_by, changed_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), id, previous.r2_object_key, key, previous.checksum_sha256,
        file.checksum, userId, now),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, github_user_id, action, created_at, result, resource_type, resource_id)
         SELECT ?, ?, 'attachment.replace', ?, 'success', 'attachment', ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), userId, now, id)
    ]);
    if (updated.meta.changes !== 1) {
      await env.ATTACHMENTS.delete(key).catch(() => undefined);
      return error(413, 'storage_quota_exceeded');
    }
  } catch {
    await env.ATTACHMENTS.delete(key).catch(() => undefined);
    return error(503, 'attachment_replace_failed');
  }
  return getAttachment(request, env, id);
}

export async function deleteAttachment(
  request: Request,
  env: AttachmentEnv,
  userId: string,
  id: string,
  config: AttachmentConfig
): Promise<Response> {
  if (!validAttachmentId(id)) return error(404, 'not_found');
  const row = await env.DB.prepare(
    'SELECT * FROM attachments WHERE id = ?'
  ).bind(id).first<AttachmentRow>();
  if (!row || row.upload_status === 'failed') return error(404, 'not_found');
  if (row.upload_status !== 'deleted') {
    const linked = await env.DB.prepare(
      `SELECT 1 FROM article_attachments WHERE attachment_id = ?
       UNION ALL SELECT 1 FROM article_drafts WHERE body LIKE ? LIMIT 1`
    ).bind(id, `%/api/attachments/${id}/%`).first();
    if (linked) return error(409, 'attachment_in_use');
    if (config.githubApp) {
      try {
        const publishedReferences = await publishedArticlesReferencingAttachment(config.githubApp, id);
        if (publishedReferences.length) return error(409, 'attachment_in_use');
      } catch {
        return error(503, 'published_source_unavailable');
      }
    }
    const [deleted] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE attachments SET upload_status = 'deleted', visibility = 'private',
         deleted_at = ?, updated_at = ? WHERE id = ? AND upload_status = 'active'`
      ).bind(Date.now(), Date.now(), id),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, github_user_id, action, created_at, result, resource_type, resource_id)
         SELECT ?, ?, 'attachment.delete', ?, 'success', 'attachment', ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), userId, Date.now(), id)
    ]);
    if (deleted.meta.changes !== 1) return error(409, 'attachment_in_use');
  }
  try {
    await env.ATTACHMENTS.delete(row.r2_object_key);
    const revisions = await env.DB.prepare(
      'SELECT previous_object_key FROM attachment_revisions WHERE attachment_id = ?'
    ).bind(id).all<{ previous_object_key: string }>();
    await Promise.all(revisions.results.map((revision) => env.ATTACHMENTS.delete(revision.previous_object_key)));
  } catch {
    return error(503, 'attachment_cleanup_pending');
  }
  return json(200, { ok: true });
}

function validAttachmentId(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

export function attachmentReferences(
  body: string,
  apiOrigin: string,
  expectedArticleId?: string
): string[] {
  const ids = new Set<string>();
  const expression = /!?\[(?:\\.|[^\]\\\r\n]){1,200}\]\((https:\/\/[^)\s]+)\)/gi;
  for (const match of body.matchAll(expression)) {
    try {
      const url = new URL(match[1]);
      const path = /^\/api\/attachments\/([a-f0-9-]{36})\/(?:preview|download)$/.exec(url.pathname);
      const references = url.searchParams.getAll('articleId');
      if (url.origin === apiOrigin && path && validAttachmentId(path[1]) &&
          !url.username && !url.password && !url.hash && url.searchParams.size === 1 &&
          references.length === 1 && /^a_[A-Za-z0-9_-]{22}$/.test(references[0]) &&
          (!expectedArticleId || references[0] === expectedArticleId)) {
        ids.add(path[1].toLowerCase());
      }
    } catch {
      continue;
    }
  }
  return [...ids];
}

export async function validateAttachmentReferences(
  env: AttachmentEnv,
  body: string,
  apiOrigin: string,
  articleId: string
): Promise<boolean> {
  const ids = attachmentReferences(body, apiOrigin, articleId);
  if (ids.length > 50) return false;
  if (!ids.length) return true;
  const placeholders = ids.map(() => '?').join(',');
  const active = await env.DB.prepare(
    `SELECT id FROM attachments WHERE upload_status = 'active' AND id IN (${placeholders})`
  ).bind(...ids).all<{ id: string }>();
  return active.results.length === ids.length;
}

export async function syncArticleAttachments(
  env: AttachmentEnv,
  articleId: string,
  body: string,
  userId: string | null,
  apiOrigin: string,
  visibility: 'private' | 'published' = 'private',
  preserveExisting = false
): Promise<boolean> {
  const ids = attachmentReferences(body, apiOrigin, articleId);
  if (!await validateAttachmentReferences(env, body, apiOrigin, articleId)) return false;
  const statements: D1PreparedStatement[] = [
    ...(preserveExisting
      ? []
      : [env.DB.prepare('DELETE FROM article_attachments WHERE article_id = ?').bind(articleId)]),
    ...ids.map((id, index) => env.DB.prepare(
      `INSERT ${preserveExisting ? 'OR IGNORE ' : ''}INTO article_attachments
       (article_id, attachment_id, display_order, inserted_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(articleId, id, index, Date.now(), Date.now())),
    ...(preserveExisting
      ? []
      : [env.DB.prepare(
        `UPDATE attachments SET visibility = ?, updated_at = ?
         WHERE id IN (SELECT attachment_id FROM article_attachments WHERE article_id = ?)`
      ).bind(visibility, Date.now(), articleId)]),
    ...ids.map((id) => env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id, article_id)
       VALUES (?, ?, 'attachment.associate', ?, 'success', 'attachment', ?, ?)`
    ).bind(crypto.randomUUID(), userId, Date.now(), id, articleId))
  ];
  if (!statements.length) return true;
  await env.DB.batch(statements);
  return true;
}

export async function readAttachment(
  request: Request,
  env: AttachmentEnv,
  config: AttachmentConfig,
  id: string,
  mode: 'preview' | 'download',
  articleId: string | null,
  admin: AttachmentAuth | null
): Promise<Response> {
  if (!validAttachmentId(id)) return error(404, 'not_found');
  const row = await env.DB.prepare(
    `SELECT * FROM attachments WHERE id = ? AND upload_status = 'active'`
  ).bind(id).first<AttachmentRow>();
  if (!row) return error(404, 'not_found');
  if (!admin) {
    if (!articleId || !/^a_[A-Za-z0-9_-]{22}$/.test(articleId) || !config.githubApp) {
      return error(403, 'forbidden');
    }
    const relationship = await env.DB.prepare(
      `SELECT 1 FROM article_attachments WHERE article_id = ? AND attachment_id = ?`
    ).bind(articleId, id).first();
    if (!relationship) return error(403, 'forbidden');
    let article;
    try {
      article = await getPublishedArticle(config.githubApp, articleId);
    } catch {
      return error(503, 'published_source_unavailable');
    }
    if (!article || !attachmentReferences(article.body, config.apiOrigin, articleId).includes(id.toLowerCase())) {
      return error(403, 'forbidden');
    }
  }
  const object = await env.ATTACHMENTS.get(row.r2_object_key);
  if (!object) return error(404, 'not_found');
  const canInline = mode === 'preview' && INLINE_MIME_TYPES.has(row.detected_mime_type);
  const mime = row.file_extension === 'svg'
    ? 'application/octet-stream'
    : row.detected_mime_type;
  const dispositionName = encodeURIComponent(row.display_filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': `${canInline ? 'inline' : 'attachment'}; filename*=UTF-8''${dispositionName}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer'
  });
  if (request.headers.has('Origin')) headers.set('Vary', 'Origin');
  if (admin) {
    await env.DB.prepare(
      `INSERT INTO audit_logs
       (id, github_user_id, action, created_at, result, resource_type, resource_id, article_id)
       VALUES (?, ?, ?, ?, 'success', 'attachment', ?, ?)`
    ).bind(crypto.randomUUID(), admin.githubUserId, `attachment.${mode}`, Date.now(), id, articleId).run();
  }
  return new Response(object.body, { status: 200, headers });
}

export const attachmentMimeTypes = ALLOWED_MIME_TYPES;
export const attachmentDefaults = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxStorageBytes: DEFAULT_MAX_STORAGE_BYTES
};
