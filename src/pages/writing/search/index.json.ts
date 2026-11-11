import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { articleUrl, hasPublishedBody, sortArticles } from '../../../lib/articles';

export const prerender = true;

export const GET: APIRoute = async () => {
  const articles = sortArticles(await getCollection('articles'))
    .filter(hasPublishedBody)
    .map((article) => ({
      href: articleUrl(article),
      body: article.body ?? ''
    }));

  return new Response(JSON.stringify(articles), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
};
