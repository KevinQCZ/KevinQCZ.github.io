import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const articles = defineCollection({
  loader: glob({
    pattern: '**/*.{md,mdx}',
    base: './src/content/articles'
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    permalink: z.string().regex(/^\d{4}\/\d{2}\/\d{2}\/[^/]+$/),
    categories: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    cover: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }, 'Cover images must use an HTTPS URL without embedded credentials.').optional()
  })
});

const projects = defineCollection({
  loader: glob({
    pattern: 'projects/**/*.{md,mdx}',
    base: './src/content'
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
    role: z.string().optional(),
    period: z.string().optional(),
    technologies: z.array(z.string()).default([])
  })
});

export const collections = { articles, projects };
