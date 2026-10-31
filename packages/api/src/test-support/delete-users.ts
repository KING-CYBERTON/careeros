import type { TablesRelationalConfig } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { eq, getTableColumns, sql } from "drizzle-orm";

// CAREEROS: the upstream trigger lock_username_claim() takes pg_advisory_xact_lock per deleted "user" row, and advisory
// locks are database-wide. Concurrent test files wiping the same usernames in different row orders deadlock (40P01).
// This helper deletes in one deterministic order and retries the deadlock, which PostgreSQL defines as retryable.

const DEADLOCK = "40P01";
const MAX_ATTEMPTS = 3;

type UserTable = PgTable & { id: { name: string }; username: { name: string } };

function sqlState(error: unknown): string | undefined {
	for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export async function deleteAllUsers(db: NodePgDatabase<TablesRelationalConfig>, userTable: UserTable): Promise<void> {
	const columns = getTableColumns(userTable) as unknown as { id: never; username: never };
	for (let attempt = 1; ; attempt++) {
		try {
			await db.transaction(async (tx) => {
				// The trigger locks lower(username); sorting by it makes every cleanup acquire locks in the same sequence.
				const rows = await tx
					.select({ id: columns.id })
					.from(userTable)
					.orderBy(sql`lower(${columns.username})`, columns.id);
				for (const row of rows as { id: string }[]) await tx.delete(userTable).where(eq(columns.id, row.id));
			});
			return;
		} catch (error) {
			if (sqlState(error) !== DEADLOCK || attempt >= MAX_ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
		}
	}
}
