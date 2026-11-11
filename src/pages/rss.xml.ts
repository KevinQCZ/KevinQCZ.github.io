import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { articleUrl, sortArticles } from '../lib/articles';
import { escapeXml } from '../lib/xml';

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    throw new Error('Set the site URL in astro.config.mjs before building the RSS feed.');
  }

  const articles = sortArticles(await getCollection('articles'));
  const channelUrl = new URL('/writing/', site).href;
  const feedUrl = new URL('/rss.xml', site).href;
  const items = articles.map((article) => {
    const url = new URL(articleUrl(article), site).href;
    return `    <item>
      <title>${escapeXml(article.data.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${article.data.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(article.data.description)}</description>
    </item>`;
  }).join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Qian Kevin - Writing</title>
    <link>${escapeXml(channelUrl)}</link>
    <description>Articles and notes on software engineering, supply chain, and applied AI.</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`,
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } }
  );
};
