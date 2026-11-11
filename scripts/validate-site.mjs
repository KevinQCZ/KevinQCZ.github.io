import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const siteOrigin = 'https://kevinqcz.github.io';
const requiredRoutes = [
  'index.html',
  'about/index.html',
  'writing/index.html',
  'writing/search/index.html',
  'writing/search/index.json',
  'writing/categories/software-engineering/index.html',
  'writing/tags/hexo/index.html',
  'projects/index.html',
  'zh/index.html',
  'archives/index.html',
  'archives/2018/index.html',
  'archives/2018/02/index.html',
  '2018/02/07/My-first-Test-Article/index.html',
  '2018/02/07/hello-world/index.html',
  'sitemap.xml',
  'rss.xml',
  'robots.txt'
];
const requiredContent = new Map([
  ['writing/index.html', [
    '<h1>Writing</h1>',
    '/writing/categories/software-engineering/',
    '/writing/tags/hexo/',
    'Hello World'
  ]],
  ['writing/search/index.html', [
    'data-writing-search',
    'data-search-entry',
    'data-search-href',
    '/js/writing-search.js'
  ]],
  ['projects/index.html', [
    'Project case studies are being prepared.',
    'No project details are published yet.'
  ]],
  ['sitemap.xml', [
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    'https://kevinqcz.github.io/2018/02/07/hello-world/'
  ]],
  ['rss.xml', [
    '<rss version="2.0"',
    'https://kevinqcz.github.io/2018/02/07/hello-world/',
    '<title>Hello World</title>'
  ]],
  ['robots.txt', [
    'Sitemap: https://kevinqcz.github.io/sitemap.xml'
  ]],
  ['archives/2018/02/index.html', [
    'Archive: February 2018',
    'Hello World',
    'My first Test Article'
  ]],
  ['2018/02/07/hello-world/index.html', [
    '<meta property="og:type" content="article">',
    '<meta property="article:published_time" content="2018-02-07T00:00:00.000Z">',
    '<nav class="table-of-contents"',
    'href="#quick-start"',
    'https://hexo.io/docs/one-command-deployment',
    'href="/2018/02/07/My-first-Test-Article/"'
  ]],
  ['2018/02/07/My-first-Test-Article/index.html', [
    'This archived post has no published body.',
    '<meta name="robots" content="noindex,follow">'
  ]]
]);

async function exists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'lib') return [];
      return walk(entryPath);
    }
    return entry.name.endsWith('.html') ? [entryPath] : [];
  }));
  return paths.flat();
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractReferences(html) {
  const references = [];
  const tags = /<(a|link|script|img|source|video|audio)\b([^>]*)>/gi;

  for (const match of html.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    const name = ['script', 'img', 'source', 'video', 'audio'].includes(tag) ? 'src' : 'href';
    const value = attribute(match[2], name);
    if (value) references.push({ tag, value });
  }

  return references;
}

function identifiers(html) {
  return new Set(
    [...html.matchAll(/\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
      .map((match) => match[1] ?? match[2])
  );
}

function targetCandidates(url) {
  const pathname = decodeURIComponent(url.pathname);
  const direct = path.resolve(outputDirectory, `.${pathname}`);

  if (pathname.endsWith('/')) return [path.join(direct, 'index.html')];
  if (path.extname(pathname)) return [direct];
  return [direct, `${direct}.html`, path.join(direct, 'index.html')];
}

const errors = [];
const htmlFiles = await walk(outputDirectory);
const htmlCache = new Map();

for (const route of requiredRoutes) {
  if (!(await exists(path.join(outputDirectory, route)))) {
    errors.push(`Missing required route: /${route}`);
  }
}

if (await exists(path.join(outputDirectory, 'projects', 'example-case-study', 'index.html'))) {
  errors.push('Unpublished project template was generated as a public route');
}

for (const [route, markers] of requiredContent) {
  const filePath = path.join(outputDirectory, route);
  if (!(await exists(filePath))) continue;

  const html = await readFile(filePath, 'utf8');
  for (const marker of markers) {
    if (!html.includes(marker)) {
      errors.push(`${route}: missing expected content "${marker}"`);
    }
  }
}

const emptyArticleUrl = `${siteOrigin}/2018/02/07/My-first-Test-Article/`;
for (const route of ['sitemap.xml', 'rss.xml']) {
  const contents = await readFile(path.join(outputDirectory, route), 'utf8');
  if (contents.includes(emptyArticleUrl)) {
    errors.push(`${route}: empty archived article must not be published in discovery feeds`);
  }
}

const searchIndexPath = path.join(outputDirectory, 'writing', 'search', 'index.json');
if (await exists(searchIndexPath)) {
  try {
    const searchIndex = JSON.parse(await readFile(searchIndexPath, 'utf8'));
    if (!Array.isArray(searchIndex) || !searchIndex.every(
      (record) => typeof record.href === 'string' && typeof record.body === 'string'
    )) {
      errors.push('writing/search/index.json: invalid search-index record shape');
    } else {
      if (searchIndex.some((record) => record.href === '/2018/02/07/My-first-Test-Article/')) {
        errors.push('writing/search/index.json: empty archived article must not be searchable');
      }
      if (!searchIndex.some((record) => record.href === '/2018/02/07/hello-world/' &&
        record.body.includes('Welcome to'))) {
        errors.push('writing/search/index.json: published article body is missing from full-text search');
      }
    }
  } catch (error) {
    errors.push(`writing/search/index.json: invalid JSON (${error.message})`);
  }
}

const searchPage = await readFile(
  path.join(outputDirectory, 'writing', 'search', 'index.html'),
  'utf8'
);
if (searchPage.includes('Welcome to Hexo')) {
  errors.push('writing/search/index.html: full article body should not be embedded in the initial page');
}

for (const filePath of htmlFiles) {
  const html = await readFile(filePath, 'utf8');
  const relativePath = path.relative(outputDirectory, filePath).split(path.sep).join('/');
  htmlCache.set(filePath, html);

  if (!/\bid=["']main["']/.test(html)) {
    errors.push(`${relativePath}: missing #main skip-link target`);
  }

  const canonicalTag = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0];
  const canonical = canonicalTag ? attribute(canonicalTag, 'href') : null;
  const ogTag = html.match(/<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/i)?.[0];
  const ogUrl = ogTag ? attribute(ogTag, 'content') : null;
  if (!canonical || canonical !== ogUrl) {
    errors.push(`${relativePath}: canonical and Open Graph URLs do not match`);
  }
  if (!/<meta\b[^>]*\bname=["']twitter:title["'][^>]*>/i.test(html) ||
      !/<meta\b[^>]*\bname=["']twitter:description["'][^>]*>/i.test(html)) {
    errors.push(`${relativePath}: missing page-specific Twitter title or description`);
  }
  const ogImageTag = html.match(/<meta\b[^>]*\bproperty=["']og:image["'][^>]*>/i)?.[0];
  const ogImage = ogImageTag ? attribute(ogImageTag, 'content') : null;
  const twitterImageTag = html.match(/<meta\b[^>]*\bname=["']twitter:image["'][^>]*>/i)?.[0];
  const twitterImage = twitterImageTag ? attribute(twitterImageTag, 'content') : null;
  const pageUrl = new URL(relativePath, `${siteOrigin}/`);
  if (!ogImage || ogImage !== twitterImage) {
    errors.push(`${relativePath}: Open Graph and Twitter images are missing or do not match`);
  } else {
    const imageUrl = new URL(ogImage, pageUrl);
    if (imageUrl.origin === siteOrigin) {
      const candidates = targetCandidates(imageUrl);
      const candidatesExist = await Promise.all(candidates.map((candidate) => exists(candidate)));
      if (!candidatesExist.some(Boolean)) {
        errors.push(`${relativePath}: unresolved social image "${ogImage}"`);
      }
    }
  }
  if (!/<meta\b[^>]*\bproperty=["']og:image:width["'][^>]*\bcontent=["']1200["']/i.test(html) ||
      !/<meta\b[^>]*\bproperty=["']og:image:height["'][^>]*\bcontent=["']630["']/i.test(html)) {
    errors.push(`${relativePath}: social image dimensions must be 1200x630`);
  }

  for (const { tag, value } of extractReferences(html)) {
    if (/^(?:mailto:|tel:|javascript:|data:|blob:)/i.test(value)) continue;

    let targetUrl;
    try {
      targetUrl = new URL(value, pageUrl);
    } catch {
      errors.push(`${relativePath}: invalid ${tag} reference "${value}"`);
      continue;
    }

    if (targetUrl.origin !== siteOrigin) continue;

    const candidates = targetCandidates(targetUrl);
    let targetPath = null;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        targetPath = candidate;
        break;
      }
    }

    if (!targetPath) {
      errors.push(`${relativePath}: unresolved ${tag} reference "${value}"`);
      continue;
    }

    if (targetUrl.hash) {
      const targetHtml = htmlCache.get(targetPath) ?? await readFile(targetPath, 'utf8');
      htmlCache.set(targetPath, targetHtml);
      let fragment;
      try {
        fragment = decodeURIComponent(targetUrl.hash.slice(1));
      } catch {
        fragment = targetUrl.hash.slice(1);
      }
      if (fragment && !identifiers(targetHtml).has(fragment)) {
        errors.push(`${relativePath}: unresolved fragment "${value}"`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${requiredRoutes.length} required routes and internal references across ${htmlFiles.length} pages.`);
}
