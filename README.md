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
uses a short-lived, high-entropy Bearer session held in page memory; it is not
stored in a cookie, localStorage, or sessionStorage. The Secure, HttpOnly
OAuth-transaction cookie is used only while completing the OAuth callback on
the API host. The site and API may be cross-site (including `github.io` and
`workers.dev`); API requests use an exact Origin allowlist, CORS, and CSRF
protection rather than third-party session cookies. Reloading or navigating to
another page clears the in-memory session and requires signing in again.
Plain HTTP localhost does not verify the HTTPS OAuth callback or Secure-cookie
behavior. Cloudflare's IP-based rate limits are approximate per location, not
global, and shared IPs may be affected. A trusted Cloudflare-provided
`CF-Connecting-IP` is required.

## In-page article editor and local drafts

Article pages stay statically generated and publicly readable. Editing controls
load only after the configured HTTPS API confirms an `ADMIN` session through
`GET /api/me`; the browser never decides its own role. Administrators can edit
article metadata and the original Markdown/MDX source, preview it safely, and save
an unpublished D1 draft. `Create pull request` submits a saved revision to a
generated GitHub branch and creates or updates a PR targeting `master`; the
Worker never merges it. Only review and merge publishes the article, after which
the existing Pages workflow builds the `master` branch. The authenticated Worker uses `GET /api/admin/articles`
and `GET /api/admin/articles/:id` to list articles and retrieve their exact
source and Git blob SHA, then `POST /api/admin/drafts`,
`PUT /api/admin/drafts/:id`, and `DELETE /api/admin/drafts/:id` for private draft
management, plus `POST /api/admin/drafts/:id/publish` for explicit PR submission.
These endpoints use the existing server-side ADMIN session and CSRF protections.
D1 migrations `0003_article_drafts.sql`, `0004_draft_management.sql`, and
`0005_cross_site_auth_and_publication.sql` preserve drafts, track revisions,
prevent stale-source publication, and record lifecycle events without article
content. Drafts are not added to public pages or the Astro content collection;
GitHub receives content only on the dedicated review branch after PR submission.

The editor does not execute MDX or custom components in its preview. Raw HTML and
JSX are shown as escaped source; Markdown image references are placeholders, and
only an explicitly entered HTTPS cover URL may load in the preview. Tests use
generated keys and mocked GitHub responses, not a real App. Worker tests cover
OAuth, handoff replay/expiry, draft authorization, CSRF, validation, persistence,
stale-source conflicts, PR create/update/reopen, and merge synchronization.

### Cloudflare and GitHub setup

The production Worker, D1 database, OAuth app, and GitHub App are not provisioned
by this repository. `worker/wrangler.jsonc` and `.dev.vars.example` are local
development templates; do not deploy the local config. Start with
`worker/wrangler.production.example.jsonc`, copy it to the ignored
`worker/wrangler.production.jsonc`, and replace every `REPLACE_WITH_*` value.
Do not commit credentials or private keys.

1. Create a Cloudflare D1 database and set its returned ID in the production
   config. The sample rate-limit namespace IDs are placeholders; configure
   unique IDs for AUTH_RATE_LIMITER and WRITE_RATE_LIMITER in your account.
   Keep `SITE_ORIGIN` as `https://kevinqcz.github.io`; set `API_ORIGIN` to the
   exact HTTPS Worker URL, for example the assigned `workers.dev` hostname.
2. Register a GitHub OAuth App with callback URL
   `<API_ORIGIN>/auth/github/callback`. Put its client ID in the config and add
   `GITHUB_CLIENT_SECRET` and a randomly generated `CSRF_SECRET` (at least 32
   random bytes) as Worker secrets.
3. Set `ADMIN_GITHUB_IDS` to the verified numeric GitHub user ID(s), not a
   username. For example, `gh api users/LOGIN --jq .id` can retrieve a public
   numeric ID; verify the result before using it.
4. Create a GitHub App installed only on `KevinQCZ/KevinQCZ.github.io`, grant
   Contents read/write and Pull requests read/write, and configure its App ID
   and repository installation ID. Add `GITHUB_APP_PRIVATE_KEY` as a Worker
   secret. The App writes only to generated draft branches and creates PRs
   targeting `master`; it cannot merge them.
5. Apply migrations and deploy from the copied production config after checking
   every binding and origin:

   ```sh
   npx wrangler d1 create personal-site-admin-production
   npx wrangler d1 migrations apply personal-site-admin-production --remote --config worker/wrangler.production.jsonc
   npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.production.jsonc
   npx wrangler secret put CSRF_SECRET --config worker/wrangler.production.jsonc
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config worker/wrangler.production.jsonc
   npx wrangler deploy --config worker/wrangler.production.jsonc
   ```
6. Copy the deployed API origin into the repository Actions variable
   `PUBLIC_AUTH_API_ORIGIN` under Settings → Secrets and variables → Actions →
   Variables. The Pages workflow injects this public origin during the static
   build; it is not a secret. The current published site remains readable even
   before the variable is configured, but admin controls will show the service
   as unavailable.
7. Verify `/api/me` returns `401` when unauthenticated, complete sign-in and
   logout on the deployed site, then test draft save, PR creation, review, and
   merge using a harmless test article before relying on production.

No Cloudflare account details, D1 ID, rate-limit namespaces, OAuth/App
credentials, or deployed Worker URL are present in this repository. The
placeholders above are not production values; remote migrations and deployment
must wait until you configure and verify the actual resources.

### Diagnosing OAuth callback failures

The Worker returns a generic `service_unavailable` response for unexpected
errors. For an exception during the GitHub OAuth callback, the Worker runtime
log includes the response's `X-Request-ID` and an allowlisted
`callback_stage`. This identifies the failing stage, not the underlying cause.
Ordinary provider errors and other expected responses retain their existing
status codes. A non-success HTTP response from the token endpoint is logged
separately with the request ID and `token_response_status`, without its body.
A successful response without a token is recorded only as an allowlisted
`token_response_error` value.
The token exchange distinguishes an exception making the request
(`token_exchange_request`) from reading or parsing its response
(`token_exchange_response`). Request exceptions also get a best-effort,
allowlisted `token_request_failure` category; `other` means the cause is
unknown. Rejected token endpoint redirects additionally record their status,
an allowlisted host category, and whether their path and scheme match; the
redirect is never followed or logged in full. Raw exception messages are never
logged by this application.

In the Cloudflare dashboard, select the deployed Worker and open its runtime
logs under **Observability** (enable logs if required). These are separate
from **Builds** logs. Start a fresh login from the site and find the runtime
entry matching the response's `X-Request-ID`. Dashboard labels and log
availability can vary by configuration. Share only the request ID and stage;
do not share callback URLs, authorization codes, state, cookies, tokens, or
secrets. This application log excludes those values, but other platform
request logs or screenshots may contain them.

Deploy diagnostics only after verifying the target Worker, environment, D1
binding, rate limiters, variables, and secrets. Do not recreate the database or
overwrite production configuration to troubleshoot a callback.

### Using the editor to publish

1. Open a published article on `https://kevinqcz.github.io/` and select **Sign in
   with GitHub**. Complete GitHub authorization; the site returns to the article
   and exposes edit controls only if the Worker confirms your allowlisted ADMIN
   identity. On `/admin/`, sign in and use **Create new article** for a new post.
2. Select **Edit article** or open a draft with **Continue editing**. Edit the
   metadata and Markdown/MDX source, use **Preview** to check it, then choose
   **Save Draft**. This stores a private D1 revision only; visitors still see
   the published article.
3. After saving, choose **Create pull request** (or **Update pull request** for
   a previous submission). This writes the draft to its isolated GitHub branch
   and opens a PR. Follow the **View pull request** link, inspect the rendered
   change, and merge the PR only when it is ready to publish.
4. The Pages workflow builds and deploys after the merge to `master`. Reload
   the article or admin draft list to verify the published result. Signing in
   again is required after a full page reload or navigation because session
   tokens are memory-only.

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
