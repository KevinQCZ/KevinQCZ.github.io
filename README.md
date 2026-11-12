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

`worker/.dev.vars.example` lists the required variable names. Copy it to the
ignored `worker/.dev.vars` and replace every placeholder with values you control;
the example is deliberately nonfunctional. Never put real credentials in Git
or chat. Worker unit tests use mocks and do not require `.dev.vars`. Local
HTTP/localhost does not satisfy the HTTPS-only origin and `__Host-` cookie
contract, so a local `wrangler dev` smoke test is not a real browser login test.
Without an explicitly built-in HTTPS API origin, the unlinked `/admin/` page
displays an unavailable state.

Authentication requires exact HTTPS site and API origins, an administrator's
numeric GitHub ID, a GitHub OAuth client and a random CSRF secret. Real OAuth
and host-only Secure cookies require separately approved HTTPS staging on
same-site sibling hosts; plain localhost testing does not verify them.
`github.io` and `workers.dev` are cross-site and third-party cookie blocking can
prevent sign-in. Cloudflare's IP-based rate limits are approximate per location,
not global, and shared IPs may be affected. A trusted Cloudflare-provided
`CF-Connecting-IP` is required. The in-page editor and draft API are described
below; the local Worker can retrieve published source through a server-side,
read-only GitHub App integration. It never writes to GitHub or publishes content.

## In-page article editor and local drafts

Article pages stay statically generated and publicly readable. Editing controls
load only after the configured HTTPS API confirms an `ADMIN` session through
`GET /api/me`; the browser never decides its own role. Administrators can edit
article metadata and the original Markdown/MDX source, preview it safely, and save
an unpublished draft. The authenticated Worker uses `GET /api/admin/articles`
and `GET /api/admin/articles/:id` to list articles and retrieve their exact
source and Git blob SHA, then `POST /api/admin/drafts`,
`PUT /api/admin/drafts/:id`, and `DELETE /api/admin/drafts/:id` for private draft
management. These endpoints use the existing server-side ADMIN session and CSRF
protections. D1 migrations `0003_article_drafts.sql` and
`0004_draft_management.sql` preserve local drafts, track revisions, and record
draft lifecycle audit events without article content. Drafts are not added to
public pages, the Astro content collection, or GitHub.

The editor does not execute MDX or custom components in its preview. Raw HTML and
JSX are shown as escaped source; Markdown image references are placeholders, and
only an explicitly entered HTTPS cover URL may load in the preview. The editor
and draft API have not been deployed remotely. To enable local published-source
retrieval and safe new-draft collision checks, configure the optional GitHub App values listed in
`worker/.dev.vars.example`; the App must be installed only on this repository
with Contents read permission. Keep the private key in the ignored
`worker/.dev.vars` file and never commit or log it. If the values are missing or
GitHub is temporarily unavailable, the admin list still returns existing private
drafts with `publishedSourceAvailable: false`; published-source reads and draft
creation fail closed with `503`, while existing drafts can still be continued or
deleted. Tests use generated keys and mocked GitHub responses, not a real App.
Local Worker tests cover draft authorization, CSRF, validation, size limits,
persistence, audit records, and revision conflicts.
The existing HTTPS-only origin and Secure-cookie requirements still apply, so
plain HTTP localhost does not provide a real browser-authenticated editing setup.

### Future Cloudflare deployment checklist (not configured or verified)

The Worker config is local-only: its D1 ID is a placeholder, `workers_dev` is
disabled, and no production route or hostname is configured. Do not deploy it
as-is. A real setup requires separate approval and owner-supplied values:

1. Select and verify the approved custom domain with sibling HTTPS site and API
   hosts. Do not use the GitHub Pages hostname with `workers.dev` for this
   cookie-based cross-origin session design.
2. Register a GitHub OAuth app using the exact callback
   `https://<API_HOST>/auth/github/callback`; configure the site and API origin
   variables to the exact HTTPS origins. The actual hostnames and callback are
   intentionally unresolved, not inferred from examples.
3. Create an environment-specific D1 database and replace the local placeholder
   binding with its real database ID. Apply migrations to the intended database
   only after explicit approval.
4. Configure the `DB`, `AUTH_RATE_LIMITER`, and `WRITE_RATE_LIMITER` bindings,
   an explicit Worker route/custom domain, and `SITE_ORIGIN`, `API_ORIGIN`,
   `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_IDS`, `GITHUB_APP_ID`, and
   `GITHUB_APP_INSTALLATION_ID`. Set the site's
   `PUBLIC_AUTH_API_ORIGIN` to the same API origin when building the static
   admin page.
5. Add `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and a randomly
   generated `CSRF_SECRET` (at least 32 bytes) as Worker secrets. The GitHub App
   needs Contents read permission for this phase; do not grant write access.
   Never commit or log secret values. Use a
   verified numeric GitHub ID; the synthetic test identity is not an
   administrator configuration.
6. Only after separately approved provisioning and review, configure the
   environment-specific Worker route and deploy it. Verify OAuth, cross-origin
   cookies, revocation, and rate limits on trusted HTTPS staging before any
   production use.

After approval, use the matching environment-specific config (never the local
placeholder config) for the corresponding Wrangler steps:

```sh
npx wrangler d1 create <environment-database-name>
npx wrangler d1 migrations apply <environment-database-name> --remote --config <environment-wrangler.jsonc>
npx wrangler secret put GITHUB_CLIENT_SECRET --config <environment-wrangler.jsonc>
npx wrangler secret put CSRF_SECRET --config <environment-wrangler.jsonc>
npx wrangler deploy --config <environment-wrangler.jsonc>
```

Configure the required `SITE_ORIGIN`, `API_ORIGIN`, `GITHUB_CLIENT_ID`,
`ADMIN_GITHUB_IDS`, D1 and rate-limit bindings, and Worker route in that
environment config before these commands. The placeholders are not executable
values. Do not apply a remote migration or deploy until the target environment,
domain, callback, credentials and approval are confirmed.

These are prerequisites, not completed deployment instructions for an existing
Cloudflare account: no domain, OAuth app, remote D1 database, Worker route,
secrets, or staging environment has been supplied or provisioned.

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
