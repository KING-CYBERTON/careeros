# Job Clipper

A Manifest V3 browser extension for Chrome and Edge. On first run you enter your organization's address and the popup shows that organization's name and logo. Sign-in (P5-T02) and clipping a job (P5-T03) come next. The extension has no product brand of its own: the organization's brand appears at run time.

## Build

From the repository root:

```sh
pnpm --filter extension build   # unpacked extension in apps/extension/dist
pnpm --filter extension pack    # builds, then zips it as apps/extension/job-clipper-<version>.zip
pnpm --filter extension test
pnpm --filter extension typecheck
```

The version comes from `apps/extension/package.json`. `pack` refuses a development build.

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
| `storage`                                    | Keep the connected organization and, later, the sign-in token in `chrome.storage.local`.                                                                                                                                         |
| `scripting`                                  | Inject the small reader that finds the job posting on the active page (P5-T03).                                                                                                                                                  |
| `optional_host_permissions: ["https://*/*"]` | Not granted at install. The popup asks the browser for the one organization origin the user enters, once they have confirmed the organization, and gives it back on Change organization. It never asks for all websites at once. |

There are no `host_permissions` and no content scripts. Extension pages run under a strict content security policy: scripts from the extension only, no `eval`, no remote code, https images and connections only.

## How the address is checked

1. The address is normalized to an origin: a host or an https URL, lowercase, no path. `http` is refused, except for the hosts a development build lists.
2. The popup calls `GET <origin>/api/openapi/branding/host` (no cookies, no redirects). The answer must have the CareerOS shape and name an organization (this needs no host permission: the server answers extension origins). The name is shown as text, the logo only if it is on the same origin, and the colour only if it is `#rrggbb`.
3. The user confirms; only then does the browser ask for access to that origin, and the connection is stored after it is granted. A popup that closes in between leaves no access behind: the next open gives back any stray host permission.
4. The server answers extension origins for that one route (`apps/server/src/http/extension-cors.ts`).

## Layout

- `src/lib/`: address normalization, branding validation, storage. Pure and tested.
- `src/popup/`: the React popup (360 px). All strings are in `strings.ts`.
- `src/background/service-worker.ts`: empty for now; T02 and T03 add to it.
- `src/manifest.ts`: the manifest, written to `dist/manifest.json` by `vite.config.ts`.
- `public/icons/`: neutral placeholder icons.

The end-to-end test is `tests/e2e/specs/careeros-extension.spec.ts`.
