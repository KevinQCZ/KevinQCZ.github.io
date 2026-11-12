export interface ArticleSeed {
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

export interface ArticleDraft extends ArticleSeed {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface DraftPayload extends ArticleSeed {
  expectedRevision: number | null;
}

export interface AdminSession {
  csrfToken: string;
  user: {
    githubId: string;
    githubLogin: string;
    role: 'ADMIN';
  };
}
