import type { FeatureKey } from "@careeros/billing";
import type { HostContext } from "@careeros/tenancy";
import {
	assertFeature,
	assertWritable,
	EntitlementError,
	getEntitlements,
	isSeatLimitDatabaseError,
	seatLimitError,
} from "@careeros/billing";
import { currentHost } from "@careeros/tenancy";
import { ORPCError, os } from "@orpc/server";

// CAREEROS (P3-T02, phase plan D3 and D4): the server-side gates that read `getEntitlements`. This file is the one
// place that decides which requests a suspended organization may still make and which plan features a procedure needs.

type EntitlementContext = {
	organizationId?: string | undefined;
	host?: HostContext | undefined;
};

const gate = os.$context<EntitlementContext>();

/** Maps an entitlement refusal to the oRPC error clients know: FORBIDDEN (403) with a stable `data.code`. */
export function toEntitlementORPCError(raised: unknown): unknown {
	// The database trigger is the race-safe backstop for the seat limit: its refusal reads like the early check's.
	const error = isSeatLimitDatabaseError(raised) ? seatLimitError() : raised;
	if (!(error instanceof EntitlementError)) return error;
	return new ORPCError("FORBIDDEN", {
		status: 403,
		message: error.message,
		data: { code: error.code, ...(error.feature === undefined ? {} : { feature: error.feature }) },
	});
}

/** The organization a request acts in: the one `protectedProcedure` resolved, else the organization host's. */
function requestOrganizationId(context: EntitlementContext): string | undefined {
	if (context.organizationId) return context.organizationId;
	const host = context.host ?? currentHost();
	return host?.kind === "org" ? host.organizationId : undefined;
}

/**
 * Writes a suspended organization may still make (D3: it can sign in and export its data, but cannot write). The key is
 * the oRPC path of the procedure. A procedure is a write when its OpenAPI route method is not GET, or when it has no
 * route method; every write that is not listed here is refused with ORG_SUSPENDED.
 *
 * Sign-out and the member's own password change are Better Auth endpoints, not oRPC procedures, so they are never
 * blocked: the suspended-organization rule for Better Auth is in `packages/auth/src/organization-enforcement.ts`
 * and covers only invitations, adding a member and role changes. "Leave the organization" is also a Better Auth
 * endpoint and is not blocked. Data export is a GET (`auth.exportData`), so it needs no entry.
 *
 * `procedure-inventory.test.ts` fails when a non-GET procedure is neither guarded by `enforceOrganizationStatus` nor
 * listed here, so a new procedure is covered by default.
 */
export const SUSPENDED_ORG_ALLOWED_WRITES: ReadonlyMap<string, string> = new Map([
	// The member's own profile (name, username, image) belongs to the account, not to the organization.
	["auth.updateProfile", "the member's own profile"],
	// Account deletion is how a member leaves the platform; it is account-level and works in any state.
	["auth.deleteAccount", "account deletion"],
	// API keys are account-level (phase plan D8). Creating or deleting one changes nothing in the organization, and a
	// key used on the suspended organization is read-only like every other credential.
	["auth.createApiKey", "creating an API key, which is account-level"],
	["auth.apiKeys.delete", "deleting an API key, which is account-level"],
	// CAREEROS (P5-T02): a member must always be able to cut off their own Job Clipper sign-in.
	["clipper.revokeToken", "revoking the member's own Job Clipper sign-in, which is account-level"],
	// Public resume views are served from a public link and do not act in the viewer's organization.
	["resume.getRoot", "public: resolves the root resume for the landing page, writes nothing"],
	["resume.statistics.recordDownload", "public: counts a download of a public resume"],
	["resume.verifyPassword", "public: checks the password of a shared resume"],
	// The ATS PDF check is public, reads an uploaded PDF and stores nothing. It is only exposed as a REST alias.
	["checkPdf", "public: analyzes an uploaded PDF and stores nothing"],
	// CAREEROS (P3-T04): billing. A suspended organization's owner must be able to pay its way out of the suspension.
	["billing.startTrial", "starting a trial, which lifts nothing by itself but is part of getting out of suspension"],
	["billing.checkout", "paying: the checkout is how a suspended organization buys its way out of the suspension"],
	["billing.changeSeats", "changing the seat count, which is part of paying the right amount"],
	["billing.cancel", "cancelling the subscription, which an owner must always be able to do"],
	["billing.portal", "opening the provider's billing portal to update a payment method"],
	// CAREEROS (P3-T07): the Super Admin console acts on the platform, not on an organization (Q340). Its procedures run
	// without an organization context, so the suspended-organization rule has nothing to read; they are listed so that
	// the inventory knows the omission is a decision. Each is refused off the platform host and checked in the database.
	["admin.orgs.setStatus", "platform console: acts on the platform, not on the admin's organization"],
	["admin.orgs.setPlan", "platform console: acts on the platform, not on the admin's organization"],
	["admin.orgs.setAiOverage", "platform console: acts on the platform, not on the admin's organization"],
	["admin.payments.record", "platform console: acts on the platform, not on the admin's organization"],
	["admin.announcements.save", "platform console: acts on the platform, not on the admin's organization"],
	["admin.announcements.end", "platform console: acts on the platform, not on the admin's organization"],
	["admin.impersonation.start", "platform console: acts on the platform, not on the admin's organization"],
	["admin.email.sendTest", "platform console: acts on the platform, not on the admin's organization"],
	// A member of a suspended organization can still dismiss a banner for themselves and end a support session.
	["announcements.dismiss", "dismissing an announcement is per user and changes nothing in the organization"],
	["impersonation.end", "ending a support session must always work, whatever state the organization is in"],
]);

/** Whether a procedure writes: its OpenAPI route method is not GET, and a procedure without a method counts as a write. */
export function isWriteRoute(route: { method?: string | undefined }): boolean {
	return route.method !== "GET";
}

/**
 * Refuses a write with ORG_SUSPENDED (403) when the request's organization is read-only. Used by `protectedProcedure`
 * and by the join procedure of an organization host. It reads entitlements only for writes, so reads add no query.
 * Its identity is what `procedure-inventory.test.ts` looks for in a procedure's middleware list.
 */
export const enforceOrganizationStatus = gate.middleware(async ({ context, path, procedure, next }) => {
	if (isWriteRoute(procedure["~orpc"].route) && !SUSPENDED_ORG_ALLOWED_WRITES.has(path.join("."))) {
		const organizationId = requestOrganizationId(context);
		if (organizationId) {
			try {
				assertWritable(await getEntitlements(organizationId));
			} catch (error) {
				throw toEntitlementORPCError(error);
			}
		}
	}
	return next();
});

/**
 * Middleware factory for a plan feature (D4): refuses with FEATURE_NOT_IN_PLAN (403, `data.feature` carries the key)
 * unless the organization's resolved feature map has the key on. It fails closed without an organization.
 */
export function requireFeature(key: FeatureKey) {
	return gate.middleware(async ({ context, next }) => {
		const organizationId = requestOrganizationId(context);
		if (!organizationId) throw new ORPCError("FORBIDDEN", { message: "No active organization" });
		try {
			assertFeature(await getEntitlements(organizationId), key);
		} catch (error) {
			throw toEntitlementORPCError(error);
		}
		return next();
	});
}
