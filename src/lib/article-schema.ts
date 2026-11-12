import { z } from 'zod';

export const articleMetadataSchema = z.object({
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
});
