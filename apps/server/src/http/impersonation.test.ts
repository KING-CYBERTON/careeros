import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P3-T07): the member-host redeem route. The database functions and Better Auth are mocked; what is checked is
// the route's own rules: organization host only, own origin only, rate limit, one generic failure, and a session that
// has no live record is ended.

const mocks = vi.hoisted(() => ({
	redeemImpersonation: vi.fn(),
	attachImpersonationSession: vi.fn(),
	consumeHandoffLimit: vi.fn(),
	createSession: vi.fn(),
	endSession: vi.fn(),
}));

vi.mock("@careeros/platform-admin", () => ({
	redeemImpersonation: mocks.redeemImpersonation,
	attachImpersonationSession: mocks.attachImpersonationSession,
}));
vi.mock("@reactive-resume/api/features/auth-handoff", () => ({ consumeHandoffLimit: mocks.consumeHandoffLimit }));
vi.mock("@reactive-resume/auth/config", () => ({
	auth: {
		api: {
			careerosImpersonationCreateSession: mocks.createSession,
			careerosHandoffEndSession: mocks.endSession,
		},
	},
}));

const { handleImpersonationRedeem } = await import("./impersonation");

const orgHost = {
	kind: "org" as const,
	organizationId: "org_a",
	slug: "acme",
	via: "subdomain" as const,
	hostname: "acme.orgs.test",
	origin: "https://acme.orgs.test",
};
const expiresAt = new Date(Date.now() + 3_000_000);
const redeemed = { targetUserId: "member-1", organizationId: "org_a", impersonatorUserId: "admin-1", expiresAt };

const post = (body: unknown, origin: string | null = orgHost.origin) =>
	new Request("https://acme.orgs.test/api/careeros/impersonation/redeem", {
		method: "POST",
		headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const valid = { id: "imp-id-1234567890ab", token: "tok-1234567890abcdef" };

const sessionResponse = (extra: Record<string, unknown> = {}) => {
	const response = Response.json({ ok: true, sessionId: "sess-1", token: "session-token", ...extra });
	response.headers.append("Set-Cookie", "better-auth.session_token=abc; Path=/; HttpOnly");
	return response;
};

beforeEach(() => {
	for (const fn of Object.values(mocks)) fn.mockReset();
	mocks.consumeHandoffLimit.mockResolvedValue(true);
	mocks.redeemImpersonation.mockResolvedValue(redeemed);
	mocks.createSession.mockImplementation(async () => sessionResponse());
	mocks.attachImpersonationSession.mockResolvedValue(true);
	mocks.endSession.mockResolvedValue(undefined);
});

describe("POST /api/careeros/impersonation/redeem", () => {
	it("redeems on the organization host, sets the session cookie and attaches the session", async () => {
		const response = await handleImpersonationRedeem(post(valid), orgHost, "203.0.113.5");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ returnTo: "/dashboard" });
		expect(response.headers.getSetCookie()).toEqual(["better-auth.session_token=abc; Path=/; HttpOnly"]);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mocks.redeemImpersonation).toHaveBeenCalledWith({
			...valid,
			targetOrigin: orgHost.origin,
			organizationId: "org_a",
		});
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					userId: "member-1",
					organizationId: "org_a",
					impersonatorUserId: "admin-1",
					expiresAt: expiresAt.toISOString(),
				},
			}),
		);
		expect(mocks.attachImpersonationSession).toHaveBeenCalledWith(valid.id, "sess-1", "member-1");
	});

	it.each([
		["the platform host", { kind: "platform" as const }],
		["an unknown host", { kind: "unknown" as const, matchesOrgPattern: false }],
	])("answers 404 on %s", async (_name, host) => {
		const response = await handleImpersonationRedeem(post(valid), host, "203.0.113.5");
		expect(response.status).toBe(404);
		expect(mocks.redeemImpersonation).not.toHaveBeenCalled();
	});

	it("refuses a request whose Origin is not the host's own, or missing", async () => {
		for (const origin of ["https://evil.test", "https://acme.orgs.test.evil.test", null]) {
			const response = await handleImpersonationRedeem(post(valid, origin), orgHost, "203.0.113.5");
			expect(response.status).toBe(403);
		}
		expect(mocks.redeemImpersonation).not.toHaveBeenCalled();
	});

	it("is rate limited before the database is asked", async () => {
		mocks.consumeHandoffLimit.mockResolvedValue(false);
		const response = await handleImpersonationRedeem(post(valid), orgHost, "203.0.113.5");
		expect(response.status).toBe(429);
		expect(mocks.redeemImpersonation).not.toHaveBeenCalled();
	});

	it("answers one generic 400 for a bad body, a failed redeem and a database error", async () => {
		const bodies = [post("not json"), post({ id: 1 }), post(valid), post(valid)];
		mocks.redeemImpersonation.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
		mocks.redeemImpersonation.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("db down"));
		const answers: unknown[] = [];
		for (const request of bodies) {
			const response = await handleImpersonationRedeem(request, orgHost, "203.0.113.5");
			answers.push([response.status, await response.json()]);
		}
		expect(answers[0]).toEqual([400, { code: "invalid_request" }]);
		expect(answers.slice(1)).toEqual([
			[400, { code: "impersonation_invalid" }],
			[400, { code: "impersonation_invalid" }],
			[400, { code: "impersonation_invalid" }],
		]);
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("ends the session and answers 400 when no live record can be attached to it", async () => {
		mocks.attachImpersonationSession.mockResolvedValue(false);
		const response = await handleImpersonationRedeem(post(valid), orgHost, "203.0.113.5");
		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(mocks.endSession).toHaveBeenCalledWith({ body: { token: "session-token" } });
	});

	it("answers 400 when the session cannot be created", async () => {
		mocks.createSession.mockRejectedValue(new Error("boom"));
		const response = await handleImpersonationRedeem(post(valid), orgHost, "203.0.113.5");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ code: "impersonation_invalid" });
	});
});
