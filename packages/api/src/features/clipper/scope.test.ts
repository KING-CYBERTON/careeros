import { describe, expect, it, vi } from "vite-plus/test";
import { generateClipperToken } from "@reactive-resume/auth/clipper-core";

const verify = vi.fn();
vi.mock("@reactive-resume/auth/config", () => ({
	auth: { api: { clipperVerifyToken: (input: unknown) => verify(input) } },
}));

const { CLIPPER_ALLOWED_PROCEDURES, assertClipperProcedureAllowed, resolveClipperAuthentication } =
	await import("./scope");

const user = { id: "u1", name: "Ada" } as never;
const findActiveUser = vi.fn(async () => user);
const orgHost = {
	kind: "org",
	organizationId: "org-a",
	slug: "a",
	via: "subdomain",
	hostname: "a.test",
	origin: "https://a.test",
} as const;

function request(token: string) {
	return new Headers({ authorization: `Bearer ${token}` });
}

describe("clipper procedure allow-list", () => {
	it("lists exactly the procedures the clipper needs", () => {
		expect([...CLIPPER_ALLOWED_PROCEDURES].sort()).toEqual([
			"applications.create",
			"branding.publicForHost",
			"clipper.cleanup",
			"clipper.findByUrl",
			"clipper.whoami",
		]);
	});

	it("lets a clipper token call an allowed procedure", () => {
		expect(() => assertClipperProcedureAllowed({ method: "clipper" }, ["clipper", "whoami"])).not.toThrow();
		expect(() => assertClipperProcedureAllowed({ method: "clipper" }, ["applications", "create"])).not.toThrow();
		// P5-T03
		expect(() => assertClipperProcedureAllowed({ method: "clipper" }, ["clipper", "findByUrl"])).not.toThrow();
		expect(() => assertClipperProcedureAllowed({ method: "clipper" }, ["clipper", "cleanup"])).not.toThrow();
	});

	it.each([
		["applications", "list"],
		["applications", "delete"],
		["auth", "getProfile"],
		["auth", "exportData"],
		["clipper", "listTokens"],
		["clipper", "revokeToken"],
		["resume", "list"],
		["branding", "get"],
		["organization", "entitlements"],
	])("refuses %s.%s with 403", (...path) => {
		expect(() => assertClipperProcedureAllowed({ method: "clipper" }, path)).toThrow(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
	});

	it("does not limit other credentials", () => {
		for (const method of ["session", "apiKey", "bearer"] as const)
			expect(() => assertClipperProcedureAllowed({ method }, ["resume", "list"])).not.toThrow();
		expect(() => assertClipperProcedureAllowed(null, ["resume", "list"])).not.toThrow();
	});
});

describe("clipper authentication", () => {
	it("ignores a request without a clipper-shaped bearer value", async () => {
		expect(await resolveClipperAuthentication(new Headers(), orgHost, findActiveUser)).toBeNull();
		expect(await resolveClipperAuthentication(request("some.jwt.token"), orgHost, findActiveUser)).toBeNull();
		expect(verify).not.toHaveBeenCalled();
	});

	it("accepts a verified token on its organization's host", async () => {
		verify.mockResolvedValueOnce({
			id: "t1",
			userId: "u1",
			organizationId: "org-a",
			host: "a.test",
			expiresAt: "2027-01-01T00:00:00.000Z",
		});
		const result = await resolveClipperAuthentication(request(generateClipperToken()), orgHost, findActiveUser);
		expect(result).toMatchObject({
			method: "clipper",
			clipper: { organizationId: "org-a", expiresAt: "2027-01-01T00:00:00.000Z" },
		});
		expect(result?.permissions).toEqual(["read", "write"]);
		expect(verify).toHaveBeenLastCalledWith({ body: expect.objectContaining({ organizationId: "org-a" }) });
	});

	it("refuses with 401 on the platform host, an unknown host and no host, without asking the database", async () => {
		verify.mockClear();
		for (const host of [
			{ kind: "platform" } as const,
			{ kind: "unknown", matchesOrgPattern: true } as const,
			undefined,
		])
			await expect(
				resolveClipperAuthentication(request(generateClipperToken()), host, findActiveUser),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(verify).not.toHaveBeenCalled();
	});

	it("refuses with 401 when the token is not valid for this organization", async () => {
		verify.mockResolvedValueOnce(null);
		await expect(
			resolveClipperAuthentication(request(generateClipperToken()), orgHost, findActiveUser),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("refuses with 401 for a suspended account", async () => {
		verify.mockResolvedValueOnce({
			id: "t1",
			userId: "u1",
			organizationId: "org-a",
			host: "a.test",
			expiresAt: "2027-01-01T00:00:00.000Z",
		});
		findActiveUser.mockResolvedValueOnce(null as never);
		await expect(
			resolveClipperAuthentication(request(generateClipperToken()), orgHost, findActiveUser),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
