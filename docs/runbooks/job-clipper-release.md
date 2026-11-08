# Job Clipper release runbook

How to ship a new version of the Job Clipper (`apps/extension`) to the Chrome Web Store and to Microsoft Edge Add-ons. One zip serves both stores and every organization.

Everything in angle brackets is a placeholder you fill in. This file holds no account ids, keys or secrets, and neither should anything you paste into the stores from it. The stores' screens change from time to time: where a label here differs from the screen, follow the screen and keep the intent.

`[TO CONFIRM]` marks an answer that needs Opus's confirmation before the first submission (questions.md, Q404).

## What you need once

- A **Chrome Web Store developer account** (a one-time registration fee). Sign in at the Chrome Web Store Developer Dashboard with the publisher Google account `<publisher account>`.
- A **Microsoft Partner Center account** enrolled in the Microsoft Edge program (free). Sign in at Partner Center with `<publisher account>` and open Microsoft Edge, then Overview.
- A published privacy policy URL: `<privacy policy URL>` (the page built from `docs/legal/privacy.md`, once Stephen has approved it).
- Store screenshots and a promotional tile, made from a build connected to a demo organization with fictional data: `<screenshots folder>`.

## 1. Bump the version

1. Open a pull request that changes `version` in `apps/extension/package.json`. That one field sets the zip name and `manifest.json`'s version.
2. Use Chrome's format: one to four whole numbers separated by dots (`0.2.0`), no suffix such as `-rc.1`. Both stores refuse a version that is not higher than the one they already hold, so always go up, even for a rollback (section 6).
3. Merge it into `develop` once CI is green. The `extension` job builds the clipper, runs the pack checks and keeps the zip for 14 days.

## 2. Build the release zip

1. In GitHub, open Actions, then `careeros-extension-release`, then Run workflow on `develop` (or the branch you are releasing). Or push the tag `clipper-v<version>` (for example `clipper-v0.2.0`); the tag must equal the version in `package.json` or the workflow stops.
2. When it is green, open the run and download the artifact `job-clipper-<version>` (GitHub keeps it 90 days). It holds:
   - `job-clipper-<version>.zip`, the file you upload;
   - `job-clipper-<version>.zip.sha256`, its checksum.
3. Unzip the download, then check the zip in the same folder: `sha256sum -c job-clipper-<version>.zip.sha256` must print `OK`. Keep the checksum with your release notes.
4. The zip passed these checks in CI (`apps/extension/scripts/pack-checks.mjs`): `manifest.json` at the root; no source maps, `.env` files, `node_modules` or test files; permissions exactly `activeTab`, `scripting`, `storage`; manifest version equal to `package.json` and in Chrome's format; at most 10 MB; no product branding strings.
5. Optional smoke test: unzip it into an empty folder, load that folder as an unpacked extension (README, "Load unpacked"), and connect to a test organization.

The workflow never touches a store and needs no store credentials.

## 3. Chrome Web Store

### First time only: create the item

1. Developer Dashboard, then Add new item, then upload `job-clipper-<version>.zip`.
2. The item gets an id (`<chrome item id>`). Write it in your private release notes, not in this repository.

### Every version

1. Open the item, then Package, then Upload new package, and choose the zip. The dashboard reads the manifest and refuses a version that is not higher.
2. **Store listing** (first time, then only when it changes):
   - Name `Job Clipper`; summary and description: save job postings from the web to your organization's job tracker, after you connect your organization's address and sign in.
   - Category: Productivity. Language: English.
   - Screenshots (1280x800 or 640x400, at least one) and the small promotional tile.
   - Do not use the CareerOS name or any organization's brand in the listing: the clipper takes the organization's brand at run time.
3. **Privacy practices** tab:
   - **Single purpose:** "Save a job posting from the web page the user is on to the job tracker of the organization the user has connected." Everything the clipper does serves that one purpose.
   - **`activeTab`:** "Lets the extension read the page the user is on only after the user clicks the extension, to find the job posting (title, company, description) to save. It is not used on any other page or at any other time."
   - **`scripting`:** "Injects the small reader that finds the job posting into the active page after the user's click. It is bundled with the extension; no remote code is loaded."
   - **`storage`:** "Keeps the connected organization's address, the sign-in token and a pending sign-in in the extension's local storage so the user stays signed in. Nothing is synced to other devices."
   - **Host permissions (optional, `https://*/*`):** "Not granted at install. When the user enters their organization's address and confirms the organization, the browser asks for access to that one origin, and the extension gives it back when the user changes organization. The extension never asks for all websites at once."
   - **Remote code:** No. All scripts ship in the package, and the page policy allows only the extension's own scripts.
   - **Data usage** (tick only what applies; `[TO CONFIRM]` against P5-T03 and `docs/legal/privacy.md` before the first submission): the job posting content the user chooses to save, and an authentication token. Certify that data is not sold to third parties, not used for purposes unrelated to the single purpose, and not used to judge creditworthiness.
   - **Privacy policy URL:** `<privacy policy URL>`. It must be the same text the legal pages publish.
4. **Distribution**: visibility `<Public or Unlisted>`, regions `<regions>`.
5. Save the draft, then Submit for review. Choose to publish automatically after approval, or deferred publishing if you want to release by hand.
6. Review usually takes from a few hours to a few days; a new item or a changed permission can take longer. Watch the publisher account's email for questions. Answer them in the dashboard and resubmit.

## 4. Microsoft Edge Add-ons

### First time only: create the extension

1. Partner Center, then Microsoft Edge, then Overview, then Create new extension, and upload `job-clipper-<version>.zip`.
2. The extension gets a product id (`<edge product id>`). Keep it in your private release notes.

### Every version

1. Open the extension, then Update, then Package, and upload the new zip.
2. **Properties:** category Productivity; privacy policy URL `<privacy policy URL>`; no website or support contact that carries a product brand beyond what your organization chooses (`<support URL>`).
3. **Store listings:** name, short and long description, screenshots and logo, the same as for Chrome.
4. **Availability:** visibility `<Public or Hidden>`, markets `<markets>`.
5. **Notes for certification:** repeat the single purpose and the `activeTab`, `scripting`, `storage` and optional host justifications from section 3. Add how to test: "Enter `<demo organization address>`, confirm the organization, choose Sign in, and approve the code on the page that opens. Open a job posting and click the extension." Provide a demo account the testers can use, entered only in this private field, never in this repository.
6. Publish. Certification usually takes a few business days. Watch the publisher account's email.

## 5. After approval

1. Install from each store's public page and check the version shown matches `<version>`.
2. Record the release (version, date, workflow run link, checksum, both store states) in your private release notes. If you tagged `clipper-v<version>`, that tag stays as the source marker.
3. Tell the organizations' admins what changed, if the popup changed.

## 6. Roll back to a previous version

Neither store lets you publish a lower version number, so a rollback ships the previous code under a new, higher version.

1. Find the last good tag or merge commit: `clipper-v<good version>`.
2. In a branch from `develop`, restore `apps/extension` to that tag (`git checkout clipper-v<good version> -- apps/extension`), then set `version` in `apps/extension/package.json` to a number higher than the bad release (for example the bad release was `0.3.0`, the fix is `0.3.1`). Open a pull request and merge it once CI is green.
3. Run the release workflow (section 2) and upload the new zip to both stores (sections 3 and 4).
4. While you wait for review, you can stop the bad release from reaching new users: in the Chrome Web Store, set the item's visibility to Unlisted or Unpublish it; in Partner Center, Hide the extension or Unpublish it. If the bad version is still in review, cancel the submission instead. Restore visibility when the fixed version is approved.
5. If the stores keep an earlier approved version for you, they will tell you; do not rely on it. The re-published zip is the rollback.
6. Server compatibility: the clipper talks to the API with a token that works only on `clipper.whoami`, `branding.publicForHost` and `applications.create`. Keep those routes backward compatible so an old clipper keeps working while a new one is in review.

## Checklist

- [ ] Version raised in `apps/extension/package.json` and merged
- [ ] `careeros-extension-release` green; zip and checksum downloaded; `sha256sum -c` prints `OK`
- [ ] Chrome Web Store: package uploaded, privacy practices answered, submitted
- [ ] Edge Add-ons: package uploaded, notes for certification written, submitted
- [ ] Both approved; installed version checked; release recorded
