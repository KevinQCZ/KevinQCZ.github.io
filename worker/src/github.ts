import { articleMetadataSchema } from '../../src/lib/article-schema';
import { parse as parseYaml } from 'yaml';

const REPOSITORY = 'KevinQCZ/KevinQCZ.github.io';
const BRANCH = 'master';
const API = 'https://api.github.com';
const MAX_TREE_FILES = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface PublishedArticleFile {
  id: string;
  articlePath: string;
  sha: string;
  fileName: string;
}

export interface PublishedArticle extends PublishedArticleFile {
  articleId: string;
  sourceFormat: 'md' | 'mdx';
  title: string;
  description: string;
  publishedAt: string;
  permalink: string;
  categories: string[];
  tags: string[];
  coverUrl: string | null;
  body: string;
}

export class GitHubSourceError extends Error {}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new GitHubSourceError('Invalid GitHub blob encoding');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function sequence(content: Uint8Array): Uint8Array {
  return concatenate([new Uint8Array([0x30]), derLength(content.length), content]);
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);
  const privateKeyOctets = concatenate([new Uint8Array([0x04]), derLength(pkcs1.length), pkcs1]);
  return sequence(concatenate([new Uint8Array([0x02, 0x01, 0x00]), algorithm, privateKeyOctets]));
}

function privateKeyBytes(pem: string): Uint8Array {
  const match = /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\s+([\s\S]+?)\s+-----END \1-----\s*$/.exec(pem);
  if (!match) throw new GitHubSourceError('Invalid GitHub App key');
  const decoded = decodeBase64(match[2]);
  return match[1] === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(decoded) : decoded;
}

async function appJwt(config: GitHubAppConfig): Promise<string> {
  if (!/^\d+$/.test(config.appId) || !/^\d+$/.test(config.installationId)) {
    throw new GitHubSourceError('Invalid GitHub App configuration');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: config.appId
  })));
  const unsigned = `${header}.${payload}`;
  const keyBytes = privateKeyBytes(config.privateKey);
  const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuffer).set(keyBytes);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new GitHubSourceError('GitHub request failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GitHubSourceError('GitHub response too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GitHubSourceError('Invalid GitHub response');
  }
}

async function installationToken(config: GitHubAppConfig, fetcher: typeof fetch): Promise<string> {
  const jwt = await appJwt(config);
  const response = await fetcher(
    `${API}/app/installations/${config.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'KevinQCZ-personal-site'
      },
      body: '{}'
    }
  );
  const result = await responseJson(response);
  if (!isRecord(result) || typeof result.token !== 'string' || !result.token) {
    throw new GitHubSourceError('Invalid GitHub installation token response');
  }
  return result.token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function githubJson(
  token: string,
  path: string,
  fetcher: typeof fetch
): Promise<unknown> {
  return responseJson(await fetcher(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KevinQCZ-personal-site'
    }
  }));
}

function validArticlePath(path: unknown): path is string {
  return typeof path === 'string' &&
    /^src\/content\/articles\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|mdx)$/.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..');
}

async function articleId(path: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(path)));
  return `a_${base64Url(digest).slice(0, 22)}`;
}

async function treeFiles(
  token: string,
  fetcher: typeof fetch
): Promise<PublishedArticleFile[]> {
  const ref = encodeURIComponent(BRANCH);
  const tree = await githubJson(
    token,
    `/repos/${REPOSITORY}/git/trees/${ref}?recursive=1`,
    fetcher
  );
  if (!isRecord(tree) || tree.truncated === true || !Array.isArray(tree.tree)) {
    throw new GitHubSourceError('Invalid or incomplete GitHub article tree');
  }
  const entries = tree.tree.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry.type === 'blob' && entry.mode === '100644' &&
    validArticlePath(entry.path) && /\.(?:md|mdx)$/.test(entry.path)
  );
  if (entries.length > MAX_TREE_FILES) throw new GitHubSourceError('Article collection exceeds the configured limit');
  const files: PublishedArticleFile[] = [];
  for (const entry of entries) {
    if (typeof entry.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(entry.sha)) {
      throw new GitHubSourceError('Invalid GitHub article SHA');
    }
    const path = entry.path as string;
    files.push({
      id: await articleId(path),
      articlePath: path,
      sha: entry.sha,
      fileName: path.slice(path.lastIndexOf('/') + 1)
    });
  }
  return files;
}

async function getBlob(token: string, sha: string, fetcher: typeof fetch): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new GitHubSourceError('Invalid GitHub blob SHA');
  const blob = await githubJson(token, `/repos/${REPOSITORY}/git/blobs/${sha}`, fetcher);
  if (!isRecord(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string' ||
      typeof blob.sha !== 'string' || blob.sha.toLowerCase() !== sha.toLowerCase()) {
    throw new GitHubSourceError('Invalid GitHub blob response');
  }
  const bytes = decodeBase64(blob.content);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new GitHubSourceError('GitHub article is too large');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubSourceError('GitHub article is not valid UTF-8');
  }
}

export function parsePublishedArticle(
  file: PublishedArticleFile,
  source: string
): PublishedArticle {
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!frontmatter) throw new GitHubSourceError('Published article has no frontmatter');
  let rawMetadata: unknown;
  try {
    rawMetadata = parseYaml(frontmatter[1]);
  } catch {
    throw new GitHubSourceError('Published article frontmatter is invalid');
  }
  const metadata = articleMetadataSchema.safeParse(rawMetadata);
  if (!metadata.success || !/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(metadata.data?.permalink ?? '')) {
    throw new GitHubSourceError('Published article metadata is invalid');
  }
  const body = source.slice(frontmatter[0].length);
  if (encoder.encode(body).byteLength > 256 * 1024) {
    throw new GitHubSourceError('Published article is too large');
  }
  return {
    ...file,
    articleId: file.id,
    sourceFormat: file.articlePath.endsWith('.md') ? 'md' : 'mdx',
    title: metadata.data.title,
    description: metadata.data.description,
    publishedAt: metadata.data.publishedAt.toISOString().slice(0, 10),
    permalink: metadata.data.permalink,
    categories: metadata.data.categories,
    tags: metadata.data.tags,
    coverUrl: metadata.data.cover ?? null,
    body
  };
}

export async function listPublishedArticles(
  config: GitHubAppConfig,
  fetcher: typeof fetch = fetch
): Promise<PublishedArticleFile[]> {
  const token = await installationToken(config, fetcher);
  return treeFiles(token, fetcher);
}

export async function getPublishedArticle(
  config: GitHubAppConfig,
  id: string,
  fetcher: typeof fetch = fetch
): Promise<PublishedArticle | null> {
  const token = await installationToken(config, fetcher);
  const file = (await treeFiles(token, fetcher)).find((candidate) => candidate.id === id);
  if (!file) return null;
  return parsePublishedArticle(file, await getBlob(token, file.sha, fetcher));
}

export async function publishedArticleConflicts(
  config: GitHubAppConfig,
  permalink: string,
  articlePath: string,
  fetcher: typeof fetch = fetch
): Promise<{ permalinkExists: boolean; pathExists: boolean }> {
  const token = await installationToken(config, fetcher);
  const files = await treeFiles(token, fetcher);
  const pathExists = files.some((file) => file.articlePath === articlePath);
  let permalinkExists = false;
  for (const file of files) {
    if (parsePublishedArticle(file, await getBlob(token, file.sha, fetcher)).permalink === permalink) {
      permalinkExists = true;
      break;
    }
  }
  return { permalinkExists, pathExists };
}

export { validArticlePath };
