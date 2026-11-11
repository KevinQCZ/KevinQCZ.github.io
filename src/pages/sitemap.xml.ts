import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import {
  articleUrl,
  sortArticles,
  taxonomyUrl,
  uniqueTaxonomies
} from '../lib/articles';
import { ARTICLES_PER_PAGE, paginateItems } from '../lib/pagination';
import { projectUrl, sortProjects } from '../lib/projects';
import { escapeXml } from '../lib/xml';

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    throw new Error('Set the site URL in astro.config.mjs before building the sitemap.');
  }

  const articles = sortArticles(await getCollection('articles'));
  const projects = sortProjects(await getCollection('projects', ({ data }) => !data.draft));
  const routes = new Set([
    '/',
    '/about/',
    '/writing/',
    '/projects/',
    '/archives/',
    '/zh/'
  ]);
  const years = new Set<number>();
  const months = new Set<string>();

  for (const article of articles) {
    const date = article.data.publishedAt;
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    years.add(year);
    months.add(`${year}/${month}`);
    routes.add(articleUrl(article));
  }

  for (const year of years) routes.add(`/archives/${year}/`);
  for (const month of months) routes.add(`/archives/${month}/`);

  for (const category of uniqueTaxonomies(articles, 'categories')) {
    routes.add(taxonomyUrl('categories', category));
  }
  for (const tag of uniqueTaxonomies(articles, 'tags')) {
    routes.add(taxonomyUrl('tags', tag));
  }
  for (const project of projects) routes.add(projectUrl(project));

  const totalPages = paginateItems(articles, 1, ARTICLES_PER_PAGE).totalPages;
  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    routes.add(`/writing/page/${pageNumber}/`);
  }

  const entries = [...routes]
    .sort((a, b) => a.localeCompare(b))
    .map((route) => `  <url><loc>${escapeXml(new URL(route, site).href)}</loc></url>`)
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
  );
};
