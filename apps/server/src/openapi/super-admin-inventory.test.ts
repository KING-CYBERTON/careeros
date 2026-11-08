import { describe, expect, it, vi } from "vite-plus/test";
// CAREEROS: P3-Q03. The Super Admin procedure inventory is built from the router object, never by hand: a procedure
// added to `admin.*` fails here until the shared inventory (with its valid input and refusals) has a row for it, and a
// row for a procedure that no longer exists fails too.
import {
	diffInventory,
	EXPECTED_REFUSAL,
	NON_STAFF_CALLERS,
	SUPER_ADMIN_PROCEDURES,
} from "@careeros/testing/super-admin-inventory";
import { isProcedure } from "@orpc/server";

vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

type Definition = { route: { method?: string; path?: string; tags?: string[]; operationId?: string } };

function walk(node: unknown, path: string[], out: Map<string, Definition>) {
	if (isProcedure(node)) {
		out.set(path.join("."), (node as unknown as { "~orpc": Definition })["~orpc"]);
		return;
	}
	if (node && typeof node === "object")
		for (const [key, child] of Object.entries(node)) walk(child, [...path, key], out);
}

async function adminProcedures() {
	const router = (await import("@reactive-resume/api/routers")).default;
	const all = new Map<string, Definition>();
	walk(router, [], all);
	return { all, admin: new Map([...all].filter(([path]) => path.startsWith("admin."))) };
}

describe("Super Admin procedure inventory", () => {
	it("lists exactly the procedures of the admin router", async () => {
		const { admin } = await adminProcedures();
		expect(admin.size, "the walk found the admin router").toBeGreaterThanOrEqual(10);
		expect(diffInventory([...admin.keys()])).toEqual({ missingFromInventory: [], staleInInventory: [] });
	}, 60_000);

	it("notices a procedure the inventory lacks and one it has too many of", () => {
		expect(diffInventory(["admin.orgs.list", "admin.brandNew"], SUPER_ADMIN_PROCEDURES.slice(0, 2))).toEqual({
			missingFromInventory: ["admin.brandNew"],
			staleInInventory: ["admin.plans"],
		});
	});

	it("keeps every procedure Internal: not in the OpenAPI document, the REST aliases or the MCP tools", async () => {
		const { admin } = await adminProcedures();
		for (const [path, definition] of admin) expect(definition.route.tags, path).toContain("Internal");

		const { generateOpenApiSpec } = await import("./generator");
		const document = (await generateOpenApiSpec({ appUrl: "https://example.test", version: "1.0.0" })) as {
			paths: Record<string, Record<string, { operationId?: string }>>;
		};
		const operationIds = Object.values(document.paths).flatMap((item) =>
			Object.values(item).map((operation) => operation.operationId ?? ""),
		);
		const adminOperationIds = [...admin.values()].map((definition) => definition.route.operationId ?? "");
		expect(adminOperationIds.every(Boolean), "every admin procedure names its operation").toBe(true);
		for (const id of adminOperationIds)
			expect(operationIds, `${id} is not in the public API document`).not.toContain(id);
		expect(Object.keys(document.paths).filter((path) => /^\/admin(\/|$)/.test(path))).toEqual([]);

		const { restAliases } = await import("@reactive-resume/api/rest");
		const aliases = new Map<string, Definition>();
		walk(restAliases, [], aliases);
		expect(aliases.size).toBeGreaterThan(20);
		const aliasIds = [...aliases.values()].map((definition) => definition.route.operationId ?? "");
		for (const id of adminOperationIds) expect(aliasIds, `${id} has no REST alias`).not.toContain(id);

		const { MCP_TOOL_NAME } = await import("@reactive-resume/mcp/tool-names");
		expect(Object.values(MCP_TOOL_NAME).filter((name) => /admin|impersonat|announcement/i.test(name))).toEqual([]);
	}, 60_000);

	it("has a refusal for every kind of caller that is not platform staff", () => {
		expect(NON_STAFF_CALLERS).toHaveLength(8);
		for (const caller of NON_STAFF_CALLERS) expect(EXPECTED_REFUSAL[caller], caller).toBeDefined();
		for (const entry of SUPER_ADMIN_PROCEDURES) {
			const input = entry.input({
				orgId: "org",
				userId: "user",
				announcementId: "ann",
				planId: "pro",
				unique: "u",
			});
			expect(input, entry.path).toBeTypeOf("object");
		}
	});
});
