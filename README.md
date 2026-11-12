# Qian Kevin's personal site

This site is built with Astro and deployed as static files to GitHub Pages.

## Local development

Use Node.js 22.23.4 or newer:

```sh
npm ci
npm run dev
```

Before publishing, run:

```sh
npm test
npm run check
npm run build
```

The production site is written to `dist/`. Do not edit generated files there.
The build also generates `sitemap.xml` and `rss.xml`; `robots.txt` points crawlers to the sitemap.

## Local administrator authentication

The authentication Worker is for local development only and is not deployed by
the Pages workflow. Tests use an isolated D1 database and mocked GitHub responses:

```sh
npm run test:worker
npm run check:worker
npx wrangler d1 migrations apply local-auth --local --config worker/wrangler.jsonc --persist-to worker/.wrangler/local
npx wrangler dev --local --config worker/wrangler.jsonc --persist-to worker/.wrangler/local
```

`worker/.dev.vars.example` lists the required settings. Actual values belong in
the ignored `worker/.dev.vars`, never in Git. For an explicitly configured site
build, `PUBLIC_AUTH_API_ORIGIN` contains only the HTTPS API origin; without it,
the unlinked `/admin/` page displays an unavailable state. This is not a
production configuration or a recommendation to enter real credentials locally.

Authentication requires exact HTTPS site and API origins, an administrator's
numeric GitHub ID, a GitHub OAuth client and a random CSRF secret. Real OAuth
and host-only Secure cookies require separately approved HTTPS staging on
same-site sibling hosts; plain localhost testing does not verify them.
`github.io` and `workers.dev` are cross-site and third-party cookie blocking can
prevent sign-in. Cloudflare's IP-based rate limits are approximate per location,
not global, and shared IPs may be affected. A trusted Cloudflare-provided
`CF-Connecting-IP` is required. No editor or publishing feature is included.

## Writing articles

Add a `.md` or `.mdx` file under `src/content/articles/`:

```md
---
title: Article title
description: A concise summary for article listings and search.
publishedAt: 2026-01-31
permalink: 2026/01/31/article-slug
categories:
  - Software engineering
tags:
  - Astro
---

Article content goes here.
```

`permalink` controls the public URL and must be unique. Keep the existing date and capitalization in legacy permalinks when editing archived articles. Categories and tags are optional and generate filtered Writing pages automatically.

## Project case studies

Copy `src/content/projects/_template.mdx` to a new `.md` or `.mdx` file in the same directory. Replace the template fields and case-study sections with approved project details, then set `draft: false` (or remove the field). Draft entries are excluded from the site and search engines.

## Deployment

GitHub Actions builds and deploys `dist/`. The repository's GitHub Pages source must be set to **GitHub Actions** for workflow deployments to take effect.
