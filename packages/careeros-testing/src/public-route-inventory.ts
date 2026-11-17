// CareerOS (P3-T05): the inventory of public HTTP routes that are not oRPC procedures and change or read tenant state.
// The oRPC procedures have their own inventory (cross-org-inventory.ts); the tables have the isolation registry
// (packages/isolation-testing). A plain Hono route has neither, so each one that can touch an organization is listed
// here with how it is protected and where the organization comes from. A unit test in apps/server compares this list
// with the routes the server registers, so a new route in a listed area fails until someone decides what it is.
//
// Pure data, no application imports.

export type PublicRouteClass =
	/** Anyone may call it, but nothing happens before the provider's signature over the raw body checks out. */
	| "public-signature-verified"
	/** Anyone holding an unforgeable, signed, short-lived token may call it. */
	| "public-capability-token"
	/** Anyone holding the shared secret may call it; the sender cannot sign its events, so a static secret header is the proof. */
	| "public-shared-secret";

export type PublicRoute = {
	class: PublicRouteClass;
	/** Which host may serve it. Anything else answers 404. */
	host: "platform";
	/** Where the organization the request acts on comes from. Never the host, a header or an unsigned field. */
	/** `none`: the route acts on no organization. */
	orgFrom: "signed-metadata" | "signed-token" | "none";
	reason: string;
};

/** `METHOD /path` of the Hono route, for the billing area (`/api/billing/*`). */
export const BILLING_PUBLIC_ROUTES: Record<string, PublicRoute> = {
	"POST /api/billing/webhook/:provider": {
		class: "public-signature-verified",
		host: "platform",
		orgFrom: "signed-metadata",
		reason:
			"Payment provider webhook (P3-T04, P3-T05). The provider's signature over the raw body is verified first and nothing touches the database before it passes; the organization comes only from the metadata CareerOS signed at checkout, or from provider ids saved on the first verified payment; a payment is confirmed with the provider before it is applied; a duplicate event is a no-op",
	},
	"GET /api/billing/fake/checkout": {
		class: "public-capability-token",
		host: "platform",
		orgFrom: "signed-token",
		reason:
			"The fake provider's test page (only while BILLING_PROVIDER=fake, which production refuses). The session token is signed and names the organization",
	},
	"POST /api/billing/fake/decision": {
		class: "public-capability-token",
		host: "platform",
		orgFrom: "signed-token",
		reason: "The fake provider's approve-or-decline action; the same signed session token",
	},
};

/** `METHOD /path` of the Hono route, for the email area (`/api/email/*`, P6-T02). */
export const EMAIL_PUBLIC_ROUTES: Record<string, PublicRoute> = {
	"POST /api/email/webhook/plunk": {
		class: "public-shared-secret",
		host: "platform",
		orgFrom: "none",
		reason:
			"Plunk event webhook (P6-T02). Plunk does not sign events, so the header x-careeros-webhook-secret is compared in constant time with PLUNK_WEBHOOK_SECRET before the body is read; a missing or wrong secret is 401. It touches no organization: a permanent bounce or a complaint adds sha256 of the address to the global suppression list through a definer function, and every other event does nothing",
	},
};
