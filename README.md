# Qian Kevin's personal site

This site is built with Astro and deployed as static files to GitHub Pages.

## Local development

Use Node.js 22.12 or newer:

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

GitHub Actions builds and deploys `dist/`. In the repository's **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**, not **Deploy from a branch**. Keep the existing **Build and deploy GitHub Pages** workflow; no additional workflow is needed.

If a separate **pages build and deployment** job fails with `Invalid YAML front matter` in an `.astro` file, Pages is trying to build the Astro source with Jekyll. Change the source setting above, then run **Build and deploy GitHub Pages** from the Actions tab on `master`. Changing files or rerunning the failed Jekyll job does not correct the publishing source.
