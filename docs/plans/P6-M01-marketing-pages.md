# P6-M01 and P6-M02 — Marketing pages: home page and organisations page

**Status:** Built at Stephen's direct request (2026-11-11), ahead of a written spec. This file records what was built so a review can follow.
**Thread:** Landing page and marketing site.

## Why

Stephen asked for a landing page and a marketing site. P6-M01 put the drafts on staging as a preview under `/landing/`. He then asked for the page to be the home page, for addresses without folder or file names, and for the standard sitemap and robots entries (P6-M02).

## What is built

- `apps/web/public/site/index.html`: the home page for job seekers (resume editor, tracker, job discovery, assistant, the Individual plan, questions).
- `apps/web/public/site/organisations.html`: the page for organisations (admin console, the Starter, Pro and Enterprise plans from PRODUCT.md §11, questions).
- `apps/web/public/site/assets/`: the part of the taste-skill kit the pages use (MIT, licence beside it). `fonts/` holds Figtree and Instrument Serif (OFL, licences beside them). `tiles.js` draws the background tiles; `enter.js` starts the entrance animation.
- `apps/server/src/static/landing.ts`: serves the pages at `/` and `/organisations` on the platform host, adds the canonical link and share card tags for the deployment's own address, and adds the build's revision to stylesheet and script addresses. A request for `/site/index.html`, `/site/organisations.html` or anything under the retired `/landing/` gets a permanent redirect to the page's address.
- `apps/server/src/static/seo.ts`: the sitemap lists `/` and `/organisations`. `robots.txt` already allowed them and names the sitemap.
- `tooling/careeros/landing-check.mjs` and its self-test: fails on an inline script, an inline event handler, a script or stylesheet from another host, a link that shows a file name, a missing local file or a missing anchor.
- `.github/workflows/careeros-landing.yml`: a separate workflow. `check` runs on every change to the pages. `deploy` runs on `develop` only and copies the pages into the running staging app container, so a change to the pages shows in about a minute. The next image deploy carries the same files.

## Rules the pages follow

- **Platform host only.** An organization's address (subdomain or custom domain) keeps its own branded home page and never shows CareerOS marketing. A build without the files falls back to the app's home page.
- The server sends the pages with its content security policy: no inline scripts, and stylesheets, scripts and fonts from this site only.
- No real prices: the cards show PRODUCT.md §11's wording until D2 is settled.
- The call to action is "Try CareerOS" and opens `/auth/register`; "Sign in" opens `/auth/login`. The footer links to the terms, the privacy policy and the open-source licenses.
- English only for now. They are not part of the React app, so they have no translations and no mobile twin. A signed-in visitor who signs out inside the app still sees the app's own home view until the page reloads.

## Audit results (Lighthouse 12, local server with the same security policy, 2026-11-11)

| Page          | Device  | Performance | Accessibility | Best practices | SEO |
| ------------- | ------- | ----------- | ------------- | -------------- | --- |
| Home          | Phone   | 95          | 100           | 100            | 100 |
| Home          | Desktop | 100         | 100           | 100            | 100 |
| Organisations | Phone   | 95          | 100           | 100            | 100 |
| Organisations | Desktop | 100         | 100           | 100            | 100 |

Fixed from the first run: the tiles were one element per cell (phone performance 77, 690 ms blocked); they are now a CSS grid with a few tinted tiles. One sidebar label failed colour contrast (3.3) and now passes (5.3). Still open: the kit's stylesheets load as separate files, which costs about a second on a slow phone connection until they are bundled into one file.

## Open points for Stephen

1. The contact address is a placeholder (`hello@careeros.example`).
2. Real prices (D2).
3. Staging is open to search engines like every other deployment. If staging should stay out of search results, that needs a setting of its own.

## Acceptance

- `node --test tooling/careeros/landing-check.test.mjs` and `node tooling/careeros/landing-check.mjs` pass.
- `tests/e2e/specs/landing-licenses.spec.ts` passes: `/` shows the home page with no console errors, `/organisations` shows the organisations page, the file names redirect, and the sitemap lists both pages.
