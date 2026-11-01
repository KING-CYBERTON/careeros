// CAREEROS: test-only helper for the auth integration suites. Not imported by runtime code.
import type { Pool } from "pg";

const ADMIN_SHUTDOWN = "57P01";

/**
 * Attaches 'error' handlers to a test pool and to every client it opens. Postgres can still deliver a
 * 57P01 (terminating connection due to administrator command) to a client that is mid-`end()` when
 * `DROP DATABASE ... WITH (FORCE)` runs; without a listener Node rethrows it as an uncaught exception.
 * Only 57P01 during teardown is ignored; every other error is rethrown on the next tick.
 */
export function guardTestPool(pool: Pool) {
	let tearingDown = false;
	const onError = (error: Error & { code?: string }) => {
		if (tearingDown && error.code === ADMIN_SHUTDOWN) return;
		queueMicrotask(() => {
			throw error;
		});
	};
	pool.on("error", onError);
	pool.on("connect", (client) => {
		client.on("error", onError);
	});
	return {
		/** Ends the pool and waits for every client to close, then it is safe to drop the database. */
		async close() {
			tearingDown = true;
			await pool.end();
			// Give sockets a tick to finish closing before the caller drops the database.
			await new Promise((resolve) => setTimeout(resolve, 100));
		},
	};
}
