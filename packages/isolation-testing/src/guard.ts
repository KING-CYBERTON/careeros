import type pg from "pg";

export const GUARD_MESSAGE = "isolation checks must run as a non-superuser, non-BYPASSRLS role";

/** Throws unless the pool's current role is neither superuser nor BYPASSRLS (either would hide RLS leaks). */
export async function assertNonPrivilegedRole(db: pg.Pool): Promise<void> {
	const { rows } = await db.query<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>(
		"SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
	);
	const role = rows[0];
	if (!role) throw new Error(`${GUARD_MESSAGE} (could not read the current role)`);
	if (role.rolsuper || role.rolbypassrls) {
		throw new Error(
			`${GUARD_MESSAGE} (connected as "${role.who}": superuser=${role.rolsuper}, bypassrls=${role.rolbypassrls})`,
		);
	}
}
