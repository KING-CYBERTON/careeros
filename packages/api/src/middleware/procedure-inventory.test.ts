import { describe, expect, it, vi } from "vite-plus/test";

// Nothing here talks to a database or Better Auth; the configuration is mocked only so the routers can be imported.
vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

type Definition = { route: { method?: string | undefined }; middlewares: readonly unknown[] };
type Procedure = { "~orpc": Definition };

const isProcedure = (value: unknown): value is Procedure =>
	typeof value === "object" &&
	value !== null &&
	"~orpc" in value &&
	typeof (value as Procedure)["~orpc"] === "object" &&
	Array.isArray((value as Procedure)["~orpc"].middlewares);

function collect(node: unknown, path: string[], into: Map<string, Procedure>): Map<string, Procedure> {
	if (isProcedure(node)) {
		into.set(path.join("."), node);
		return into;
	}
	if (typeof node === "object" && node !== null)
		for (const [key, child] of Object.entries(node)) collect(child, [...path, key], into);
	return into;
}

const sameMiddlewares = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length && a.every((middleware, index) => middleware === b[index]);

// P3-T02: every oRPC procedure that writes is either covered by the suspended-organization rule or is on the explicit
// allow-list, so a procedure added later is refused for a suspended organization by default. A procedure writes when
// its OpenAPI route method is not GET (no method counts as a write).
describe("write procedures and the suspended-organization rule", () => {
	it("covers every non-GET oRPC procedure, REST aliases included, or lists it", async () => {
		const { enforceOrganizationStatus, SUSPENDED_ORG_ALLOWED_WRITES } = await import("./entitlements");
		const router = (await import("../routers/index")).default;
		const { restAliases } = await import("../routers/rest");
		const procedures = collect(router, [], new Map());
		const aliases = collect(restAliases, [], new Map());

		const allowedMiddlewares = [...SUSPENDED_ORG_ALLOWED_WRITES.keys()].flatMap((path) => {
			const procedure = procedures.get(path);
			return procedure ? [procedure["~orpc"].middlewares] : [];
		});

		const uncovered: string[] = [];
		for (const [path, procedure] of procedures) {
			const definition = procedure["~orpc"];
			if (definition.route.method === "GET") continue;
			if (definition.middlewares.includes(enforceOrganizationStatus)) continue;
			if (SUSPENDED_ORG_ALLOWED_WRITES.has(path)) continue;
			uncovered.push(`${path} (${definition.route.method ?? "no method"})`);
		}
		for (const [path, procedure] of aliases) {
			const definition = procedure["~orpc"];
			if (definition.route.method === "GET") continue;
			if (definition.middlewares.includes(enforceOrganizationStatus)) continue;
			if (SUSPENDED_ORG_ALLOWED_WRITES.has(path)) continue;
			// An alias is the same procedure under another name: it is allow-listed when its original is.
			if (allowedMiddlewares.some((middlewares) => sameMiddlewares(middlewares, definition.middlewares))) continue;
			uncovered.push(`rest alias ${path} (${definition.route.method ?? "no method"})`);
		}

		expect(
			uncovered,
			"Each of these writes is neither guarded by enforceOrganizationStatus (use protectedProcedure) nor listed in SUSPENDED_ORG_ALLOWED_WRITES.",
		).toEqual([]);
		// The inventory is real: a loose walk that found nothing would pass the check above.
		expect(procedures.size).toBeGreaterThan(150);
		expect(
			[...procedures.values()].filter((procedure) => procedure["~orpc"].route.method !== "GET").length,
		).toBeGreaterThan(100);
	}, 120_000);

	it("lists only procedures that exist, each with a reason", async () => {
		const { SUSPENDED_ORG_ALLOWED_WRITES } = await import("./entitlements");
		const router = (await import("../routers/index")).default;
		const { restAliases } = await import("../routers/rest");
		const procedures = collect(router, [], new Map());
		const aliases = collect(restAliases, [], new Map());
		for (const [path, reason] of SUSPENDED_ORG_ALLOWED_WRITES) {
			expect(procedures.has(path) || aliases.has(path), `${path} is not an oRPC procedure`).toBe(true);
			expect(reason.trim().length, `${path} needs a reason`).toBeGreaterThan(5);
		}
	}, 120_000);

	it("guards the writes that matter by name", async () => {
		const { enforceOrganizationStatus } = await import("./entitlements");
		const router = (await import("../routers/index")).default;
		const procedures = collect(router, [], new Map());
		for (const path of [
			"resume.create",
			"applications.create",
			"coverLetters.create",
			"branding.update",
			"settings.update",
			"organizationDomain.add",
			"organizationHost.join",
			"aiProviders.create",
			"storage.uploadFile",
		])
			expect(procedures.get(path)?.["~orpc"].middlewares, path).toContain(enforceOrganizationStatus);
	}, 120_000);
});
