// CAREEROS (P3-T07, phase plan D6): what a refused or failed platform-admin call looks like to the server.

export type AdminErrorCode =
	/** The actor is not a platform admin (or is banned, or does not exist). */
	| "not_admin"
	/** The actor is a platform admin who has not turned on two-factor authentication. */
	| "two_factor_required"
	/** An admin cannot be impersonated. */
	| "cannot_impersonate_admin"
	/** The request names something that does not exist. */
	| "not_found"
	/** The request is not valid (a missing reason, a bad period, a status the organization already has). */
	| "invalid";

export class AdminError extends Error {
	readonly code: AdminErrorCode;

	constructor(code: AdminErrorCode, message?: string) {
		super(message ?? code);
		this.name = "AdminError";
		this.code = code;
	}
}

/** The message of a PostgreSQL error and of everything it wraps (Drizzle puts the driver's error under its own). */
export function databaseMessage(error: unknown): string {
	const parts: string[] = [];
	for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
		parts.push(current.message);
		current = current.cause;
	}
	return parts.join("\n");
}

const PREFIX = "careeros_admin: ";

/**
 * Turns the exception a `careeros_admin_*` function raised into an `AdminError`. The functions raise messages that
 * start with `careeros_admin: ` and mean something to a person; anything else is not ours and is returned unchanged.
 */
export function toAdminError(error: unknown): unknown {
	if (error instanceof AdminError) return error;
	const text = databaseMessage(error);
	const at = text.indexOf(PREFIX);
	if (at < 0) return error;
	const message = text.slice(at + PREFIX.length).split("\n")[0] ?? "";
	if (message.startsWith("the actor is not a platform admin")) return new AdminError("not_admin", message);
	if (message.startsWith("two-factor authentication is required"))
		return new AdminError("two_factor_required", message);
	if (message.startsWith("a platform admin cannot be impersonated"))
		return new AdminError("cannot_impersonate_admin", message);
	if (message.startsWith("unknown ")) return new AdminError("not_found", message);
	return new AdminError("invalid", message);
}

/** Runs `fn` and maps a database refusal of ours to an `AdminError`. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toAdminError(error);
	}
}
