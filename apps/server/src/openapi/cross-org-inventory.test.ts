import { describe, expect, it, vi } from "vite-plus/test";
// CAREEROS: P1-Q03. The e2e fuzz keeps its inventory logic in a plain module; this test proves it against the router object.
import {
	buildRequest,
	ITEM_IDS_ONLY,
	NO_TENANT_ID,
	OVERRIDES,
	readOperations,
	type OpenApiDocument,
	type SeedIds,
	ID_KINDS,
} from "@careeros/testing/cross-org-inventory";
import { isProcedure } from "@orpc/server";

vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

// Procedures that no OpenAPI route serves; each takes no input that names a row.
const RPC_ONLY = ["customDomain.suggestion", "resume.getRoot", "storage.deleteFile", "storage.uploadFile"];

function walk(
	node: unknown,
	path: string[],
	out: Map<string, { route: { method?: string; path?: string; tags?: string[] } }>,
) {
	if (isProcedure(node)) {
		out.set(path.join("."), (node as unknown as { "~orpc": { route: object } })["~orpc"] as never);
		return;
	}
	if (node && typeof node === "object")
		for (const [key, child] of Object.entries(node)) walk(child, [...path, key], out);
}

async function load() {
	const { generateOpenApiSpec, openAPIRouter } = await import("./generator");
	const router = (await import("@reactive-resume/api/routers")).default;
	const document = (await generateOpenApiSpec({
		appUrl: "https://rxresu.me",
		version: "9.8.7",
	})) as unknown as OpenApiDocument;
	return { document, router, openAPIRouter };
}

describe("cross-organization id fuzz inventory", () => {
	it("covers every procedure of the router object", async () => {
		const { document, router, openAPIRouter } = await load();
		const operations = new Set(readOperations(document).map((operation) => operation.key));
		const procedures = new Map<string, { route: { method?: string; path?: string; tags?: string[] } }>();
		walk(openAPIRouter, [], procedures);
		const routerOnly = new Map<string, unknown>();
		walk(router, [], routerOnly as never);
		expect(routerOnly.size).toBeGreaterThan(150);

		const unserved: string[] = [];
		for (const [name, definition] of procedures) {
			const { method, path, tags } = definition.route;
			if (!method || !path || tags?.includes("Internal")) {
				unserved.push(name);
				continue;
			}
			expect(
				operations.has(`${method} ${path}`),
				`${name} (${method} ${path}) is missing from the OpenAPI document`,
			).toBe(true);
		}
		// A procedure that only RPC serves must be known here, so adding one is a decision.
		expect(unserved.filter((name) => !name.startsWith("rest.")).sort()).toEqual(RPC_ONLY);
	}, 60_000);

	it("has a request for every operation that takes an id, and a true skip list", async () => {
		const { document } = await load();
		const operations = readOperations(document);
		const keys = new Set(operations.map((operation) => operation.key));
		for (const key of Object.keys(NO_TENANT_ID)) expect(keys.has(key), `skip list entry ${key} is unknown`).toBe(true);

		const ids = Object.fromEntries(ID_KINDS.map((kind) => [kind, `id-of-${kind}`])) as SeedIds;
		const problems: string[] = [];
		for (const operation of operations) {
			const skipped = operation.key in NO_TENANT_ID;
			if (skipped) {
				if (!ITEM_IDS_ONLY.has(operation.key))
					expect(operation.idFields, `${operation.key} is skipped but takes an id`).toEqual([]);
				continue;
			}
			expect(operation.idFields.length, `${operation.key} takes no id and is not on the skip list`).toBeGreaterThan(0);
			buildRequest(document, operation, ids, OVERRIDES[operation.key], problems);
		}
		expect(problems).toEqual([]);
	}, 60_000);
});
