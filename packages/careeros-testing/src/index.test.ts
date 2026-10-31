import type { TestPools } from "./index";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_ROLE, createOrgIds, createPools, createTestSchema, getTestEnv, withOrgContext } from "./index";

const run = promisify(execFile);

describe("getTestEnv", () => {
	it("returns both URLs when both variables are set", () => {
		expect(
			getTestEnv({ CAREEROS_TEST_DATABASE_URL: "postgres://owner", CAREEROS_TEST_APP_DATABASE_URL: "postgres://app" }),
		).toEqual({ ownerUrl: "postgres://owner", appUrl: "postgres://app" });
	});

	it("throws naming the missing owner variable", () => {
		expect(() => getTestEnv({ CAREEROS_TEST_APP_DATABASE_URL: "postgres://app" })).toThrow(
			/CAREEROS_TEST_DATABASE_URL/,
		);
	});

	it("throws naming the missing app variable", () => {
		expect(() => getTestEnv({ CAREEROS_TEST_DATABASE_URL: "postgres://owner" })).toThrow(
			/CAREEROS_TEST_APP_DATABASE_URL/,
		);
	});

	it("treats an empty value as missing", () => {
		expect(() => getTestEnv({ CAREEROS_TEST_DATABASE_URL: "", CAREEROS_TEST_APP_DATABASE_URL: "x" })).toThrow(
			/CAREEROS_TEST_DATABASE_URL/,
		);
	});
});

describe("createOrgIds", () => {
	it("returns two distinct text ids in the upstream id format", () => {
		const { orgA, orgB } = createOrgIds();
		expect(typeof orgA).toBe("string");
		expect(orgA).not.toBe(orgB);
		expect(orgA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

describe("database helpers", () => {
	let pools: TestPools;

	beforeAll(() => {
		pools = createPools();
	});

	afterAll(async () => {
		await pools.close();
	});

	const schemaExists = async (name: string) => {
		const { rowCount } = await pools.owner.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [name]);
		return rowCount === 1;
	};

	it("creates unique schemas and drops them", async () => {
		const [a, b] = await Promise.all([createTestSchema(pools.owner), createTestSchema(pools.owner)]);
		try {
			expect(a.name).not.toBe(b.name);
			expect(await schemaExists(a.name)).toBe(true);
			expect(await schemaExists(b.name)).toBe(true);
		} finally {
			await Promise.all([a.drop(), b.drop()]);
		}
		expect(await schemaExists(a.name)).toBe(false);
		expect(await schemaExists(b.name)).toBe(false);
	});

	it("rejects an unsafe schema prefix", async () => {
		await expect(createTestSchema(pools.owner, 'x"; drop')).rejects.toThrow(/Invalid schema prefix/);
	});

	it("lets the app role use a created schema, with default table privileges", async () => {
		const schema = await createTestSchema(pools.owner);
		try {
			await pools.owner.query(`CREATE TABLE "${schema.name}".t (id text)`);
			await pools.app.query(`INSERT INTO "${schema.name}".t (id) VALUES ('a')`);
			const { rows } = await pools.app.query(`SELECT id FROM "${schema.name}".t`);
			expect(rows).toEqual([{ id: "a" }]);
		} finally {
			await schema.drop();
		}
	});

	it("connects the app pool as a non-superuser without BYPASSRLS", async () => {
		const { rows } = await pools.app.query(
			"SELECT current_user AS who, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
		);
		expect(rows).toEqual([{ who: APP_ROLE, rolsuper: false, rolbypassrls: false }]);
	});

	it("sets the org id transaction-locally", async () => {
		const { orgA } = createOrgIds();
		const inside = await withOrgContext(pools.app, orgA, async (client) => {
			const { rows } = await client.query("SELECT current_setting('app.current_org_id', true) AS org");
			return rows[0].org;
		});
		expect(inside).toBe(orgA);

		const { rows } = await pools.app.query("SELECT current_setting('app.current_org_id', true) AS org");
		expect(rows[0].org ?? "").toBe("");
	});

	it("does not leak the org id to the next transaction on a reused connection", async () => {
		const single = createPools({ ownerUrl: getTestEnv().ownerUrl, appUrl: getTestEnv().appUrl });
		try {
			const { orgA } = createOrgIds();
			await withOrgContext(single.app, orgA, async () => undefined);
			const { rows } = await single.app.query("SELECT current_setting('app.current_org_id', true) AS org");
			expect(rows[0].org ?? "").toBe("");
		} finally {
			await single.close();
		}
	});

	it("rolls back and rethrows when the callback fails", async () => {
		const schema = await createTestSchema(pools.owner);
		try {
			await pools.owner.query(`CREATE TABLE "${schema.name}".t (id text)`);
			const { orgA } = createOrgIds();
			await expect(
				withOrgContext(pools.app, orgA, async (client) => {
					await client.query(`INSERT INTO "${schema.name}".t (id) VALUES ('x')`);
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			const { rows } = await pools.owner.query(`SELECT count(*)::int AS n FROM "${schema.name}".t`);
			expect(rows[0].n).toBe(0);
		} finally {
			await schema.drop();
		}
	});

	it("commits when the callback succeeds", async () => {
		const schema = await createTestSchema(pools.owner);
		try {
			await pools.owner.query(`CREATE TABLE "${schema.name}".t (id text)`);
			const { orgA } = createOrgIds();
			await withOrgContext(pools.app, orgA, (client) =>
				client.query(`INSERT INTO "${schema.name}".t (id) VALUES ('y')`),
			);
			const { rows } = await pools.owner.query(`SELECT count(*)::int AS n FROM "${schema.name}".t`);
			expect(rows[0].n).toBe(1);
		} finally {
			await schema.drop();
		}
	});

	it("runs db:test-role idempotently", async () => {
		const options = { cwd: new URL("..", import.meta.url).pathname, env: process.env };
		await run("node", ["scripts/db-test-role.mjs"], options);
		await run("node", ["scripts/db-test-role.mjs"], options);
		const { rows } = await pools.app.query("SELECT 1 AS ok");
		expect(rows).toEqual([{ ok: 1 }]);
	});
});
