import type { CollectionEntry } from 'astro:content';

export type Article = CollectionEntry<'articles'>;
export type TaxonomyKind = 'categories' | 'tags';

export function sortArticles(articles: Article[]): Article[] {
  return [...articles].sort((a, b) => {
    const dateDifference = b.data.publishedAt.getTime() - a.data.publishedAt.getTime();
    return dateDifference || a.data.title.localeCompare(b.data.title);
  });
}

export function articleUrl(article: Article): string {
  return `/${article.data.permalink}/`;
}

export function taxonomySlug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function taxonomyUrl(kind: TaxonomyKind, value: string): string {
  const section = kind === 'categories' ? 'categories' : 'tags';
  return `/writing/${section}/${taxonomySlug(value)}/`;
}

export function uniqueTaxonomies(articles: Article[], kind: TaxonomyKind): string[] {
  return [...new Set(articles.flatMap((article) => article.data[kind]))]
    .sort((a, b) => a.localeCompare(b));
}

export function formatArticleDate(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone: 'UTC'
  }).format(date);
}
