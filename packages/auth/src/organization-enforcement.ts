import {
	assertSeatAvailable,
	assertWritable,
	EntitlementError,
	getEntitlements,
	hasFreeSeat,
	isSeatLimitDatabaseError,
	seatLimitError,
} from "@careeros/billing";
import { APIError } from "better-auth/api";

// CAREEROS (P3-T02, phase plan D3): the seat and suspension rules for the paths that add a member or change an
// organization through Better Auth's organization plugin. The oRPC side is `packages/api/src/middleware/entitlements.ts`.
//
// Paths that add a member (each is checked here or in the oRPC join):
//   - `/organization/create-invitation`  -> `beforeCreateInvitation` (a pending invitation holds a seat, so a full
//     organization cannot invite)
//   - `/organization/accept-invitation`  -> `beforeAcceptInvitation` (refused if seats were lost after the invitation)
//   - `auth.api.addMember` (server-only, no HTTP route) -> `beforeAddMember`
//   - `/organization/create`             -> `beforeAddMember` for the creator (a new organization is never full)
//   - open sign-up on an organization host -> `guardOrgHostSignUp` and `createPersonalOrganization`
//   - the oRPC `organizationHost.join`   -> `joinHostOrganization`
// Blocked for a suspended organization (read-only): invitation, accept, add member and role change.

/** Better Auth's error for an entitlement refusal: FORBIDDEN with the code clients act on. */
export function toAuthError(raised: unknown): unknown {
	// The database trigger is the race-safe backstop for the seat limit: its refusal reads like the early check's.
	const error = isSeatLimitDatabaseError(raised) ? seatLimitError() : raised;
	if (!(error instanceof EntitlementError)) return error;
	return APIError.from("FORBIDDEN", { code: error.code, message: error.message });
}

type MemberAdd = { releasesSeat?: boolean };

/** Refuses when the organization is suspended or has no free seat for one more member. */
export async function assertOrganizationAcceptsMember(organizationId: string, options: MemberAdd = {}): Promise<void> {
	try {
		const entitlements = await getEntitlements(organizationId);
		assertWritable(entitlements);
		assertSeatAvailable(entitlements, options.releasesSeat ?? false);
	} catch (error) {
		throw toAuthError(error);
	}
}

/** Whether the organization is writable and has a seat for one more member. */
export async function hostOrganizationHasSeat(organizationId: string): Promise<boolean> {
	const entitlements = await getEntitlements(organizationId);
	return !entitlements.readOnly && hasFreeSeat(entitlements);
}

/** Refuses when the organization is suspended. */
export async function assertOrganizationWritable(organizationId: string): Promise<void> {
	try {
		assertWritable(await getEntitlements(organizationId));
	} catch (error) {
		throw toAuthError(error);
	}
}

/** Whether an invitation currently holds a seat in `seatsUsed` (pending and not expired). */
export function invitationHoldsSeat(
	invitation: { status: string; expiresAt: Date | string },
	now = new Date(),
): boolean {
	return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > now.getTime();
}

/**
 * The hooks of the organization plugin that enforce the plan. Merged into `organizationOptions.organizationHooks`.
 * Each one returns nothing, so the plugin continues with its own data.
 */
export const organizationEnforcementHooks = {
	beforeCreateInvitation: async ({ organization }: { organization: { id: string } }): Promise<void> => {
		await assertOrganizationAcceptsMember(organization.id);
	},
	beforeAcceptInvitation: async ({
		invitation,
		organization,
	}: {
		invitation: { status: string; expiresAt: Date | string };
		organization: { id: string };
	}): Promise<void> => {
		await assertOrganizationAcceptsMember(organization.id, { releasesSeat: invitationHoldsSeat(invitation) });
	},
	beforeAddMember: async ({ organization }: { organization: { id: string } }): Promise<void> => {
		await assertOrganizationAcceptsMember(organization.id);
	},
	beforeUpdateMemberRole: async ({ organization }: { organization: { id: string } }): Promise<void> => {
		await assertOrganizationWritable(organization.id);
	},
};

type AdapterLike = {
	create?: (...args: never[]) => Promise<unknown>;
	transaction?: (...args: never[]) => Promise<unknown>;
};

/**
 * Wraps a Better Auth database adapter so the seat-limit trigger's refusal (see `isSeatLimitDatabaseError`) reaches the
 * client as FORBIDDEN `SEAT_LIMIT_REACHED` instead of a 500. Better Auth rethrows any error that is not an APIError,
 * and no hook sees it, so the translation has to sit at the adapter. The early check in the hooks gives the same
 * answer without a race; this covers the requests that lose one. Only `create` (member and invitation inserts) and
 * the adapters Better Auth gets inside `transaction` are wrapped.
 */
export function withSeatLimitErrors<T extends object>(adapter: T): T {
	return new Proxy(adapter, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (property === "create") {
				return async (...args: unknown[]) => {
					try {
						return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
					} catch (error) {
						throw toAuthError(error);
					}
				};
			}
			if (property === "transaction") {
				return (callback: (trx: AdapterLike) => Promise<unknown>) =>
					(value as (cb: (trx: AdapterLike) => Promise<unknown>) => Promise<unknown>).call(target, (trx) =>
						callback(withSeatLimitErrors(trx)),
					);
			}
			return value.bind(target);
		},
	});
}

/** `withSeatLimitErrors` for a Better Auth adapter factory such as `drizzleAdapter(...)`. */
export function withSeatLimitErrorsFactory<Options, Adapter extends object>(
	factory: (options: Options) => Adapter,
): (options: Options) => Adapter {
	return (options) => withSeatLimitErrors(factory(options));
}
