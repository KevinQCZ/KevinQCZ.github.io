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

export function hasPublishedBody(article: Pick<Article, 'body'>): boolean {
  return Boolean(article.body?.trim());
}

export function taxonomySlug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

export function taxonomyUrl(kind: TaxonomyKind, value: string): string {
  const section = kind === 'categories' ? 'categories' : 'tags';
  return `/writing/${section}/${taxonomySlug(value)}/`;
}

export function uniqueTaxonomies(articles: Article[], kind: TaxonomyKind): string[] {
  const taxonomies = [...new Set(articles.flatMap((article) => article.data[kind]))]
    .sort((a, b) => a.localeCompare(b));
  const slugs = new Map<string, string>();

  for (const taxonomy of taxonomies) {
    const slug = taxonomySlug(taxonomy);
    if (!slug) {
      throw new Error(`Taxonomy labels must not be empty (${kind}).`);
    }

    const existing = slugs.get(slug);
    if (existing && existing !== taxonomy) {
      throw new Error(
        `Taxonomy slug collision in ${kind}: "${existing}" and "${taxonomy}" both map to "${slug}".`
      );
    }
    slugs.set(slug, taxonomy);
  }

  return taxonomies;
}

export function formatArticleDate(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone: 'UTC'
  }).format(date);
}
