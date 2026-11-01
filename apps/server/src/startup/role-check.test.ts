import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { assertRuntimeRoleEnforcesRls, inspectRuntimeRole } from "./role-check";

const queryable = (row: Record<string, unknown> | undefined) => ({
	query: async () => ({ rows: row ? [row as never] : [] }),
});
const good = { role: "careeros_app", is_owner: false, rolsuper: false, rolbypassrls: false };

afterEach(() => vi.restoreAllMocks());

describe("runtime role check", () => {
	it("reports no problems for an unprivileged role", async () => {
		expect(await inspectRuntimeRole(queryable(good))).toEqual({ role: "careeros_app", problems: [] });
	});

	it("names every problem", async () => {
		const report = await inspectRuntimeRole(
			queryable({ role: "postgres", is_owner: true, rolsuper: true, rolbypassrls: true }),
		);
		expect(report.problems).toEqual(["owns the tenant tables", "is a superuser", "has BYPASSRLS"]);
	});

	it.each([
		["owner", { is_owner: true }],
		["superuser", { rolsuper: true }],
		["bypassrls", { rolbypassrls: true }],
	])("exits startup in production for a %s role", async (_name, extra) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(
			assertRuntimeRoleEnforcesRls(queryable({ ...good, role: "careeros_owner", ...extra }), "production"),
		).rejects.toThrow(/careeros_owner/);
		expect(error).toHaveBeenCalled();
	});

	it("only warns outside production", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(
			assertRuntimeRoleEnforcesRls(queryable({ ...good, role: "postgres", rolsuper: true }), "test"),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"postgres"'));
	});

	it("passes silently in production for the application role", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(assertRuntimeRoleEnforcesRls(queryable(good), "production")).resolves.toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});
});
