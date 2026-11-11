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

GitHub Actions builds and deploys `dist/`. The repository's GitHub Pages source must be set to **GitHub Actions** for workflow deployments to take effect.

If the generated **pages build and deployment** workflow fails with `Invalid YAML front matter` in an `.astro` file, GitHub Pages is using its Jekyll builder instead of the Astro workflow. To fix this:

1. Open the repository's **Settings → Pages → Build and deployment**.
2. Set **Source** to **GitHub Actions**. Keep the existing `.github/workflows/deploy.yml`; no template workflow is needed.
3. Under **Actions → Build and deploy GitHub Pages**, choose **Run workflow** on `master`.

Re-running the failed Jekyll job will not switch builders. This is a repository setting, not a source-code error; adding `.nojekyll` would not compile the Astro site.
