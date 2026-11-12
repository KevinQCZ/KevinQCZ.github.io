export interface ArticleLocator {
  articleId: string;
  permalink: string;
}

export interface ArticleContent {
  permalink: string;
  sourceFormat: 'md' | 'mdx';
  title: string;
  description: string;
  publishedAt: string;
  categories: string[];
  tags: string[];
  coverUrl: string | null;
  body: string;
}

export interface EditorSeed extends ArticleContent {
  id: string;
  articleId: string | null;
  articlePath: string;
  sha: string;
}

export interface ArticleSeed extends EditorSeed {
  articleId: string;
  articlePath: string;
  sha: string;
}

export interface ArticleDraft extends ArticleContent {
  id: string;
  articlePath: string | null;
  baseSha: string | null;
  status: 'DRAFT' | 'PENDING_PUBLICATION' | 'PUBLISHED' | 'UNPUBLISHED';
  revision: number;
  createdAt: number;
  updatedAt: number;
  publicationState: 'NOT_SUBMITTED' | 'OPEN' | 'CLOSED' | 'MERGED';
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  submittedRevision: number | null;
}

export interface DraftPayload extends ArticleContent {
  articleId: string | null;
  expectedRevision: number | null;
}

export interface ArticleListEntry {
  id: string;
  articlePath: string;
  sha: string;
  fileName: string;
}

export interface DraftListEntry extends Omit<ArticleDraft, 'body'> {}

export interface AdminArticleDetail {
  article: ArticleSeed;
  draft: ArticleDraft | null;
}

export interface AdminSession {
  accessToken: string;
  csrfToken: string;
  user: {
    githubId: string;
    githubLogin: string;
    role: 'ADMIN';
  };
}
