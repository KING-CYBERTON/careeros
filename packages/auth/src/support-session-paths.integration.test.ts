import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { isAuthPathRefusedWhileImpersonating } from "@careeros/platform-admin/policy";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// CAREEROS (P3-T09, Q421): the list of Better Auth paths a support session may not call is derived from Better Auth's own
// endpoint list, so a plugin update that adds a path which issues a token, creates a client, links an account or ends
// sessions fails here instead of passing unnoticed. Real configuration, real plugins, a database of its own.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

/** A path whose name says it deals in credentials, clients, linked accounts or sessions. */
const CREDENTIAL_PATH =
	/token|oauth2|client|consent|authorize|jwks?|link|unlink|revoke|session|api-key|passkey|two-factor|device|password|email|delete-user|secret|verify|otp|magic|callback|sign-in|sign-up/;

/**
 * Credential-looking paths that a support session MAY call, each with the reason. Anything else that looks like a
 * credential path must be refused in policy.ts.
 */
const ALLOWED_WHILE_IMPERSONATING: Record<string, string> = {
	"/get-session": "reads the support session itself; hands out no credential",
	"/list-sessions": "lists sessions, changes none",
	"/sign-out": "ends the support session; the admin may leave at any time",
	"/reset-password": "needs a token from the member's mailbox, which the admin does not hold",
	"/request-password-reset": "sends the member a mail; hands the admin nothing",
	"/send-verification-email": "sends the member a mail; hands the admin nothing",
	"/verify-email": "needs a token from the member's mailbox",
	"/list-accounts": "lists linked accounts, changes none",
	"/account-info": "reads one linked account, changes none",
	"/get-session-token-status": "reads a status",
	"/jwks": "public keys",
	"/token": "switched off over HTTP (disabledPaths) and a pathless JWT mint is not reachable",
	"/sign-in/email": "a sign-in as another user replaces the support session; it needs that user's password",
	"/sign-in/username": "as /sign-in/email",
	"/sign-in/social": "starts a provider flow for a new session, not for the member's",
	"/sign-in/anonymous": "creates a new anonymous user",
	"/sign-in/magic-link": "mails a link to its owner",
	"/sign-up/email": "creates a new user",
	"/callback/:id": "provider callback for a sign-in the caller started",
	"/verify-email-otp": "needs a code from the member's mailbox",
	"/email-otp/send-verification-otp": "mails the code to its owner",
	"/email-otp/verify-email": "needs a code from the member's mailbox",
	"/email-otp/check-verification-otp": "needs a code from the member's mailbox",
	"/email-otp/request-password-reset": "mails the member",
	"/email-otp/reset-password": "needs a code from the member's mailbox",
	"/device/clipper/token": "redeemed by the clipper with its own device code, no session",
	"/device": "the user-code page; approval is /device/approve, which is refused",
	"/magic-link/verify": "needs a link from the member's mailbox",
	"/sign-in/email-otp": "needs a code from the member's mailbox",
	"/api-key/get": "returns key metadata; the key value is shown once, at creation, which is refused",
	"/api-key/list": "returns key metadata, never a key value",
	"/reset-password/:token": "needs the token from the member's mailbox, which the admin does not hold",
	"/update-session": "session fields only; it cannot extend the support session, whose expiry is the record's",
	"/update-user": "profile fields; the member's role and email are not reachable through it",
};

describe.skipIf(!configured)("support session path policy follows Better Auth's endpoint list", () => {
	let database: IsolatedTestDatabase;
	let app: Pool;
	let owner: Pool;
	let auth: typeof import("./config").auth;
	let restorePool: (() => void) | undefined;
	let paths: string[] = [];

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("authpaths_t09");
		app = new Pool({ connectionString: database.appUrl });
		owner = new Pool({ connectionString: database.ownerUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.APP_URL = "http://localhost:3000";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		({ auth } = await import("./config"));
		const endpoints = Object.values(auth.api as unknown as Record<string, { path?: string }>);
		paths = [
			...new Set(endpoints.map((endpoint) => endpoint.path).filter((path): path is string => Boolean(path))),
		].sort();
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	it("reads a believable endpoint list", () => {
		expect(paths.length).toBeGreaterThan(40);
		expect(paths).toContain("/oauth2/create-client");
		expect(paths).toContain("/revoke-other-sessions");
	});

	it("refuses every path that issues a token, creates a client, links an account or ends sessions", () => {
		const unhandled = paths.filter(
			(path) =>
				!path.startsWith("/admin/") &&
				CREDENTIAL_PATH.test(path) &&
				!isAuthPathRefusedWhileImpersonating(path) &&
				!(path in ALLOWED_WHILE_IMPERSONATING),
		);
		expect(unhandled, `Refuse these in IMPERSONATION_REFUSED_AUTH_PATHS, or allow them here with a reason`).toEqual([]);
	});

	it("keeps every allowed entry honest: none of them is refused", () => {
		for (const path of Object.keys(ALLOWED_WHILE_IMPERSONATING)) {
			expect(isAuthPathRefusedWhileImpersonating(path), path).toBe(false);
		}
	});
	describe("in a live support session", () => {
		const cookieOf = (headers: Headers) =>
			headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
		let memberCookie = "";
		let supportCookie = "";

		beforeAll(async () => {
			const suffix = randomUUID().slice(0, 8);
			const signUp = async (label: string) => {
				const { headers, response } = await auth.api.signUpEmail({
					body: {
						name: label,
						email: `${label}-${suffix}@example.test`,
						password: "correct-horse-battery",
						username: `${label}-${suffix}`,
					} as never,
					returnHeaders: true,
				});
				return { cookie: cookieOf(headers), id: response.user.id };
			};
			const member = await signUp("member");
			const admin = await signUp("support");
			memberCookie = member.cookie;
			const org = await owner.query<{ organization_id: string }>(
				`SELECT organization_id FROM member WHERE user_id = $1`,
				[member.id],
			);
			const { headers } = await (
				auth.api as unknown as {
					careerosImpersonationCreateSession: (input: unknown) => Promise<{ headers: Headers }>;
				}
			).careerosImpersonationCreateSession({
				body: {
					userId: member.id,
					organizationId: org.rows[0]?.organization_id ?? "none",
					impersonatorUserId: admin.id,
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				returnHeaders: true,
			});
			supportCookie = cookieOf(headers);
		}, 60_000);

		const call = (path: string, cookie: string, method = "POST") =>
			auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method,
					headers: {
						cookie,
						"content-type": "application/json",
						origin: "http://localhost:3000",
						host: "localhost:3000",
					},
					...(method === "POST" ? { body: JSON.stringify({}) } : {}),
				}),
			);
		const code = async (response: Response) => ((await response.json().catch(() => ({}))) as { code?: string }).code;

		it.each([
			"/oauth2/create-client",
			"/oauth2/register",
			"/oauth2/consent",
			"/verify-password",
			"/get-access-token",
			"/refresh-token",
			"/revoke-session",
			"/revoke-sessions",
			"/revoke-other-sessions",
		])("refuses %s with 403 and the support-session code", async (path) => {
			const response = await call(path, supportCookie);
			expect(response.status).toBe(403);
			expect(await code(response)).toBe("IMPERSONATION_NOT_ALLOWED");
		});

		it("refuses the OAuth authorize and token endpoints, which take a GET and a form", async () => {
			const authorize = await call("/oauth2/authorize?client_id=x&response_type=code", supportCookie, "GET");
			expect(authorize.status).toBe(403);
			expect(await code(authorize)).toBe("IMPERSONATION_NOT_ALLOWED");
			const token = await auth.handler(
				new Request("http://localhost:3000/api/auth/oauth2/token", {
					method: "POST",
					headers: {
						cookie: supportCookie,
						"content-type": "application/x-www-form-urlencoded",
						origin: "http://localhost:3000",
						host: "localhost:3000",
					},
					body: "grant_type=client_credentials",
				}),
			);
			expect(token.status).toBe(403);
		});

		// Normalization: case, repeated and trailing slashes, encoded characters and dot segments. Better Auth's router
		// may not route these at all (404); what must never happen is a success.
		it.each([
			"/OAuth2/create-client",
			"/oauth2//register",
			"/oauth2/register/",
			"/oauth2%2Fcreate-client",
			"/oauth2/%63reate-client",
			"/Revoke-Other-Sessions",
			"//revoke-other-sessions/",
			"/oauth2/./create-client",
		])("never lets the variant %s succeed", async (path) => {
			const response = await call(path, supportCookie);
			expect([403, 404]).toContain(response.status);
			if (response.status === 403) expect(await code(response)).toBe("IMPERSONATION_NOT_ALLOWED");
		});

		it("does not refuse the same paths outside a support session", async () => {
			for (const path of ["/oauth2/create-client", "/oauth2/register", "/revoke-other-sessions", "/revoke-sessions"]) {
				const response = await call(path, memberCookie);
				expect(await code(response), path).not.toBe("IMPERSONATION_NOT_ALLOWED");
			}
		});

		it("leaves an ordinary read alone in a support session", async () => {
			const response = await call("/get-session", supportCookie, "GET");
			expect(response.status).toBe(200);
		});
	});
});
