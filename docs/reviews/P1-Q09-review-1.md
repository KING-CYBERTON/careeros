# P1-Q09 review 1 (Opus, 2026-11-01)

Branch: fix/P1-Q09-cleanup-db-time (dbd71cc2f)
Verdict: approve, subject to fully green CI.

## Checked

- Storage cleanup now uses the database `now()` for due, claim, lease and retry times. The new overload follows the T09 definer pattern. The old overload stays for one release so that rolling deploys keep working.
- A regression test sets the JavaScript clock behind the database clock, enqueues, and runs a pass straight away. It fails on the old code and passes on the new. The Q08 backdating workaround has been removed.
- `agent-tenancy` and `delete-users` now run on isolated databases. A checksum of every function and grant in `public` was unchanged across two full api runs, which shows no suite rewrites them any more.
- `bindGlobalPoolForTesting` is a test-only seam, and production never calls it. The `db` proxy now resolves `globalThis.__drizzle` on each access, which has the same cost and the same behavior in production.

## Decisions

- **Q74:** the audit is accepted, since the other workers compare against columns the app writes itself. Drop the old overload in the first Phase 1b migration.
- **Q75:** the seam is accepted. Follow-up nit: make `bindGlobalPoolForTesting` throw when `NODE_ENV === "production"`. Do it in the next PR that touches `client.ts`. The suites that use unique ids, run no global worker and replay no migrations can stay on the shared database.
