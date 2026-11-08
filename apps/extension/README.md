# Job Clipper

A Manifest V3 browser extension for Chrome and Edge. On first run you enter your organization's address and the popup shows that organization's name and logo. Sign-in (P5-T02) and clipping a job (P5-T03) are built in. The extension has no product brand of its own: the organization's brand appears at run time.

## Build

From the repository root:

```sh
pnpm --filter extension build   # unpacked extension in apps/extension/dist
pnpm --filter extension run pack    # builds, checks, then zips it as apps/extension/job-clipper-<version>.zip
pnpm --filter extension test
pnpm --filter extension typecheck
```

The version comes from `apps/extension/package.json`. `pack` refuses a development build. Use `run pack`: a bare `pnpm pack` is pnpm's own command and does not run this script.

### Packing, pack checks and releases (P5-C01)

`pack` reads the finished zip back and runs the checks in `scripts/pack-checks.mjs`; if any fails, the zip is deleted and the command fails. The zip must have `manifest.json` at its root, hold no source maps, `.env*` files, `node_modules` or test files, ask for exactly `activeTab`, `scripting` and `storage`, carry the `package.json` version in Chrome's format (one to four whole numbers, no suffix such as `-rc.1`), stay within 10 MB, and contain none of the product-branding words of `tooling/careeros/branding-gate.mjs`. `src/pack-checks.test.mjs` runs each check against a deliberately bad zip.

CI (`careeros-ci`, job `extension`) runs `pnpm --filter extension run pack` on every change to the clipper, the packages it imports, the workflow or the lockfile, and keeps the zip for 14 days. The `careeros-extension-release` workflow (run by hand or by pushing a tag `clipper-v<version>`) builds `job-clipper-<version>.zip` with a SHA-256 checksum and keeps both for 90 days. It uploads to no store. To bump the version, release and submit to the Chrome Web Store and Edge Add-ons, follow [docs/runbooks/job-clipper-release.md](../../docs/runbooks/job-clipper-release.md).

### Development build

`vp build --mode development` (or `pnpm --filter extension dev`, which rebuilds on change) makes a build that may reach `http://localhost` and nothing else over http. To reach other http hosts while testing, list them:

```sh
EXTENSION_DEV_HTTP_HOSTS="localhost,*.orgs.test" pnpm --filter extension build --mode development
```

A production build reaches no http address at all.

## Load unpacked

**Chrome:** open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick `apps/extension/dist`.

**Edge:** open `edge://extensions`, turn on Developer mode, choose Load unpacked, and pick `apps/extension/dist`.

Click the toolbar icon, enter your organization's address (for example `careers.example.org`), check the name and logo, choose Yes, connect, and allow access when the browser asks. Change organization in the popup forgets the connection and gives the access back.

## Permissions

The manifest asks for exactly these. A test checks them.

| Permission                                   | Why                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                  | Read the page the user is on, only after they click the extension (P5-T03).                                                                                                                                                      |
| `storage`                                    | Keep the connected organization, the sign-in token and a pending sign-in in `chrome.storage.local`.                                                                                                                              |
| `scripting`                                  | Inject the small reader that finds the job posting on the active page (P5-T03).                                                                                                                                                  |
| `optional_host_permissions: ["https://*/*"]` | Not granted at install. The popup asks the browser for the one organization origin the user enters, once they have confirmed the organization, and gives it back on Change organization. It never asks for all websites at once. |

There are no `host_permissions` and no content scripts. Extension pages run under a strict content security policy: scripts from the extension only, no `eval`, no remote code, https images and connections only.

## Signing in (P5-T02)

1. **Sign in** asks `POST <origin>/api/auth/device/code` for a code (client id `careeros-job-clipper`, no cookies). The popup shows the code and an **Open approval page** button that opens `<origin>/device?user_code=...` in a new tab.
2. The member signs in on that page, checks the code and the organization, and approves. The popup polls `POST <origin>/api/auth/device/clipper/token` at the server's interval, 5 seconds slower after each `slow_down`, until the code is approved, denied or expired (10 minutes).
3. The answer is a clipper token. It is stored in `chrome.storage.local` together with its origin and is sent only as `Authorization: Bearer` to that origin (`authorizedRequest` refuses any other, never follows redirects, never sends cookies). The server stores only its hash.
4. **Sign out** revokes the token on the server (`/api/auth/device/clipper/revoke`) and deletes it here. **Change organization** does both and also forgets the connection. A token the server no longer knows (revoked, expired, member removed) returns the popup to signed out.

Polling runs while the popup is open (a Manifest V3 service worker cannot keep a timer); a pending sign-in is kept in storage and resumes when the popup is opened again. The manifest permissions are unchanged. The server answers extension origins (CORS, no cookies) on the sign-in routes too, so sign-in works even when the browser has not granted host access (`apps/server/src/http/extension-cors.ts`). Sign-in works only on an organization host (its subdomain or active custom domain); on any other address the popup says the address does not support sign-in. A token works only on that organization's hosts and only for `clipper.whoami`, `clipper.findByUrl`, `clipper.cleanup`, `branding.publicForHost` and `applications.create`. Members see and revoke their sign-ins under Settings on web and mobile.

## Clipping a job (P5-T03)

Open the popup on a job page while signed in.

1. **Read.** The popup injects one small function (`src/lib/reader.ts`, `chrome.scripting.executeScript`, permissions `activeTab` and `scripting`, nothing new) into the active tab. It runs in the extension's isolated world, runs none of the page's scripts, adds no listener, changes nothing and returns plain strings. Every read is bounded (20 JSON-LD blocks, 40 candidate blocks, 200,000 text nodes, an iterative walk) and cut to a cap. It reads text, never `innerHTML`.
2. **Map.** `src/lib/posting.ts` turns that into the form: `JobPosting` JSON-LD first (a single object, an array, `@graph`, `@type` as a string or an array; malformed blocks are skipped), otherwise the Open Graph title, the first heading or the tab title, the site name or a meta tag for the company, and the largest `main`, `article` or `[role=main]` for the description. Values pass through an inert HTML parser that yields text only and are cut to 300 characters (fields) and 20,000 (description). The tab address is the default posting address (https only, no fragment, no `utm_*` or other tracking parameters).
3. **Confirm.** The form shows where the values came from: "Found on the page" (JSON-LD), "Best guess" (heuristics) or "Fill in". Title and company are required. Everything is shown as text in form fields. A page that cannot be read shows "This page can't be read. You can still fill the form in."
4. **Duplicate check.** `GET /api/openapi/clipper/find-by-url` returns at most an id and a title of the member's own application with the same address in the organization. The popup says "Already in your tracker" with an Open link, and saving stays possible.
5. **Save.** `POST /api/openapi/applications` with the first stage (`saved`) and the source `clipper`. The server rebuilds a clipper request from the clip's own fields, cleans the description to plain text and applies the caps. "Saved" links to the application on the organization's host. An organization that is read-only (`ORG_SUSPENDED`), a sign-in that ended (401) and a network error each get a readable message, and a failed save keeps the form.
6. **Tidy with AI (optional).** Shown only when `clipper.whoami` says `tidyAvailable` (the plan includes platform AI and the monthly allowance has credits left). `POST /api/openapi/clipper/cleanup` makes one metered call (feature `clipper.cleanup`, the fast model) to the platform AI, never to a member's saved key. The page text goes to the model as a marked data block, and the answer must pass the same field checks or nothing changes. A used-up allowance returns `AI_QUOTA_EXCEEDED` and the popup says so.

The fixtures for the reader tests are fictional pages in `src/lib/posting.fixtures.ts` (`example.test` addresses only). The e2e cannot grant `activeTab`, so it replaces `chrome.tabs.query` and `chrome.scripting.executeScript` in the popup with shims that run the real reader in a local page (see docs/questions.md Q363).

## How the address is checked

1. The address is normalized to an origin: a host or an https URL, lowercase, no path. `http` is refused, except for the hosts a development build lists.
2. The popup calls `GET <origin>/api/openapi/branding/host` (no cookies, no redirects). The answer must have the CareerOS shape and name an organization (this needs no host permission: the server answers extension origins). The name is shown as text, the logo only if it is on the same origin, and the colour only if it is `#rrggbb`.
3. The user confirms; only then does the browser ask for access to that origin, and the connection is stored after it is granted. A popup that closes in between leaves no access behind: the next open gives back any stray host permission.
4. The server answers extension origins for that one route (`apps/server/src/http/extension-cors.ts`).

## Layout

- `src/lib/`: address normalization, branding validation, storage, the page reader (`reader.ts`), the posting mapper (`posting.ts`) and the clip API calls (`clip-api.ts`). Pure and tested.
- `src/popup/`: the React popup (360 px). `ClipView.tsx` is the clip form. All strings are in `strings.ts`.
- `src/background/service-worker.ts`: empty for now; T02 and T03 add to it.
- `src/manifest.ts`: the manifest, written to `dist/manifest.json` by `vite.config.ts`.
- `public/icons/`: neutral placeholder icons.

The end-to-end test is `tests/e2e/specs/careeros-extension.spec.ts`.
