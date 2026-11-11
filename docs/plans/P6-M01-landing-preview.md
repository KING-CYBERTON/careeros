# P6-M01 — Landing pages: static preview on staging

**Status:** Built at Stephen's direct request (2026-11-11), ahead of a written spec. This file records what was built so a review can follow.
**Thread:** Landing page and marketing site.

## Why

Stephen asked for a landing page and a marketing site, then asked to see the drafts on staging. The home page at `/` stays as it is (the P2-T08 neutral page) until he approves the content and the prices (D2).

## What it adds

- `apps/web/public/landing/index.html`: the home page for job seekers (resume editor, tracker, job discovery, assistant, the Individual plan, questions).
- `apps/web/public/landing/organisations.html`: the page for organisations (admin console, the Starter, Pro and Enterprise plans from PRODUCT.md §11, questions).
- `apps/web/public/landing/assets/`: the part of the taste-skill kit the pages use (MIT, licence beside it). `fonts/` holds Figtree and Instrument Serif (OFL, licences beside them). `tiles.js` draws the background tiles; `enter.js` starts the entrance animation.
- `tooling/careeros/landing-check.mjs` and its self-test: fails on an inline script, an inline event handler, a script or stylesheet from another host, a missing local file or a missing anchor.
- `.github/workflows/careeros-landing.yml`: a separate workflow. `check` runs on every change to the pages. `deploy` runs on `develop` only and copies the pages into the running staging app container, so a change shows at `/landing/index.html` in about a minute. The next image deploy carries the same files.

## Rules the pages follow

- They are plain files under `public/`, so the server sends them with its content security policy: no inline scripts, and stylesheets, scripts and fonts from this site only.
- Both pages carry `noindex` while they are a preview.
- No real prices: the cards show PRODUCT.md §11's wording until D2 is settled.
- The call to action is "Try CareerOS" and opens `/auth/register`.
- English only for now. They are not part of the React app, so they have no translations and no mobile twin.

## Open points for Stephen

1. The contact address is a placeholder (`hello@careeros.example`).
2. Real prices (D2).
3. Whether these pages replace `/` on the platform host, and whether organisation hosts keep their own branded home. Replacing `/` needs a spec of its own: the pages would move into the prerendered React home page, with translations.

## Acceptance

- `node --test tooling/careeros/landing-check.test.mjs` and `node tooling/careeros/landing-check.mjs` pass.
- After a merge to `develop`, `https://<staging host>/landing/index.html` and `/landing/organisations.html` load with no console errors, and the links between them work.
