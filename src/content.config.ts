import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { articleMetadataSchema } from './lib/article-schema';

const articles = defineCollection({
  loader: glob({
    pattern: '**/*.{md,mdx}',
    base: './src/content/articles'
  }),
  schema: articleMetadataSchema
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
