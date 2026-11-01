import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createPools, createTestSchema, getTestEnv, type TestPools, type TestSchema } from "@careeros/testing";

// Real PostgreSQL through the `careeros_app` role (no BYPASSRLS). Skipped only when the CAREEROS_TEST_* variables are
// absent; CI sets them. The unqualified `member` table lives in a throwaway schema put first on the search path.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("tenancy core (real Postgres)", () => {
	let pools: TestPools;
	let schema: TestSchema;
	let tenancy: typeof import("./index");
	let client: typeof import("@reactive-resume/db/client");
	let sql: typeof import("drizzle-orm").sql;

	const setting = async () => {
		const { rows } = await client
			.getPool()
			.query<{ value: string | null }>("select current_setting('app.current_org_id', true) as value");
		return rows[0]?.value ?? null;
	};
	const settingViaDb = async () => {
		const result = await client.db.execute<{ value: string | null }>(
			sql`select current_setting('app.current_org_id', true) as value`,
		);
		return result.rows[0]?.value ?? null;
	};
	const pid = async () => {
		const result = await client.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
		return result.rows[0]?.pid;
	};

	// P1-Q08: `release(error)` ends the client without waiting, so its server backend can outlive the call by a few
	// milliseconds. Wait for it to leave; the assertion itself is unchanged and still fails if the connection stays.
	const expectBackendGone = (backendPid: number | undefined) =>
		vi.waitFor(
			async () => {
				const { rows } = await pools.owner.query("select 1 from pg_stat_activity where pid = $1", [backendPid]);
				expect(rows).toHaveLength(0);
			},
			{ timeout: 5_000, interval: 25 },
		);

	beforeAll(async () => {
		const env = getTestEnv();
		pools = createPools(env);
		schema = await createTestSchema(pools.owner, "tenancy_test");
		await pools.owner.query(
			`create table "${schema.name}"."member" (id text primary key, organization_id text not null, user_id text not null, created_at timestamptz not null default now())`,
		);
		const url = new URL(env.appUrl);
		url.searchParams.set("options", `-c search_path=${schema.name},public`);
		// The db client reads DATABASE_URL at import time, so set it before the dynamic imports.
		process.env.DATABASE_URL = url.toString();
		client = await import("@reactive-resume/db/client");
		sql = (await import("drizzle-orm")).sql;
		tenancy = await import("./index");
	}, 60_000);

	afterAll(async () => {
		await client?.getPool().end();
		await schema?.drop();
		await pools?.close();
	});

	it("requireOrgId returns the scope's organization and throws org_required outside one (P1-T04)", async () => {
		expect(() => tenancy.requireOrgId()).toThrowError(expect.objectContaining({ code: "org_required" }));
		expect(await tenancy.withOrgContext("org_a", async () => tenancy.requireOrgId())).toBe("org_a");
		// After the scope ended there is no organization again.
		expect(() => tenancy.requireOrgId()).toThrowError(expect.objectContaining({ code: "org_required" }));
	});

	it("shows the context inside fn and clears it after return", async () => {
		const seen = await tenancy.withOrgContext("org_a", async () => ({
			viaPool: await setting(),
			viaDb: await settingViaDb(),
			current: tenancy.currentOrgId(),
		}));
		expect(seen).toEqual({ viaPool: "org_a", viaDb: "org_a", current: "org_a" });
		expect(await setting()).toBe("");
		expect(tenancy.currentOrgId()).toBeUndefined();
	});

	it("clears the context after fn throws and does not reuse that client", async () => {
		let failedPid: number | undefined;
		await expect(
			tenancy.withOrgContext("org_a", async () => {
				failedPid = await pid();
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// A destroyed client is replaced by a fresh connection, which has no setting at all.
		expect(await setting()).toBeNull();
		// The destroyed connection is gone from the server.
		await expectBackendGone(failedPid);
	});

	it("keeps the pool usable and returns a healthy client after success", async () => {
		const first = await tenancy.withOrgContext("org_a", pid);
		const second = await tenancy.withOrgContext("org_b", pid);
		// A cleanly released client is reused by the pool.
		expect(second).toBe(first);
	});

	it("destroys a client whose context reset fails", async () => {
		let leakedPid: number | undefined;
		await tenancy.withOrgContext("org_a", async () => {
			leakedPid = await pid();
			// Break the session so the reset query cannot succeed (aborted transaction).
			await client.getPool().query("begin");
			await client
				.getPool()
				.query("select 1/0")
				.catch(() => {});
		});
		await expectBackendGone(leakedPid);
		expect(await setting()).toBeNull();
	});

	it("isolates 50 concurrent calls with alternating orgs", async () => {
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, index) => {
				const org = index % 2 === 0 ? "org_even" : "org_odd";
				return tenancy.withOrgContext(org, async () => {
					await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
					const first = await settingViaDb();
					await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
					return { org, first, again: await setting(), current: tenancy.currentOrgId() };
				});
			}),
		);
		for (const result of results) {
			expect(result.first).toBe(result.org);
			expect(result.again).toBe(result.org);
			expect(result.current).toBe(result.org);
		}
		expect(await setting()).toBe("");
	});

	it("has no context outside withOrgContext", async () => {
		const value = await setting();
		expect(value === null || value === "").toBe(true);
	});

	it("reuses the client for a nested call with the same org, including db.transaction", async () => {
		await tenancy.withOrgContext("org_a", async () => {
			const outer = await pid();
			await tenancy.withOrgContext("org_a", async () => {
				expect(await pid()).toBe(outer);
			});
			await client.db.transaction(async (tx) => {
				const result = await tx.execute<{ pid: number; value: string }>(
					sql`select pg_backend_pid() as pid, current_setting('app.current_org_id', true) as value`,
				);
				expect(result.rows[0]).toEqual({ pid: outer, value: "org_a" });
			});
			expect(await settingViaDb()).toBe("org_a");
		});
	});

	it("rejects a nested call with a different org and keeps the outer scope intact", async () => {
		await tenancy.withOrgContext("org_a", async () => {
			await expect(tenancy.withOrgContext("org_b", async () => "x")).rejects.toMatchObject({
				name: "TenancyError",
				code: "org_switch_in_scope",
			});
			expect(await settingViaDb()).toBe("org_a");
		});
	});

	describe("continuations that outlive the scope", () => {
		it("fails a timer that queries after its scope ended, without touching another org's scope", async () => {
			let timerOutcome: Promise<unknown> | undefined;
			let timerFired!: () => void;
			const fired = new Promise<void>((resolve) => {
				timerFired = resolve;
			});
			await tenancy.withOrgContext("org_a", async () => {
				timerOutcome = new Promise((resolve) => {
					setTimeout(() => {
						settingViaDb().then(
							(value) => resolve({ value }),
							(error: unknown) => resolve({ error }),
						);
						timerFired();
					}, 40);
				});
				return "done";
			});
			// Another org's scope is active (and likely holds the very same pooled client) when the timer fires.
			const seenByOther = await tenancy.withOrgContext("org_b", async () => {
				await fired;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return settingViaDb();
			});
			const outcome = (await timerOutcome) as { value?: string | null; error?: { code?: string } };
			expect(outcome.value).toBeUndefined();
			expect(outcome.error?.code).toBe("scope_closed");
			expect(seenByOther).toBe("org_b");
		});

		it("fails getPool() and a nested withOrgContext from a closed scope", async () => {
			const outcome = new Promise<{ pool?: string | undefined; nested?: string | undefined }>((resolve) => {
				void tenancy
					.withOrgContext("org_a", async () => {
						setTimeout(() => {
							const result: { pool?: string | undefined; nested?: string | undefined } = {};
							try {
								void client.getPool().query("select 1");
							} catch (error) {
								result.pool = (error as { code?: string }).code;
							}
							tenancy
								.withOrgContext("org_a", async () => "x")
								.catch((error: { code?: string }) => {
									result.nested = error.code;
								})
								.finally(() => resolve(result));
						}, 20);
					})
					.catch(() => {});
			});
			await expect(outcome).resolves.toEqual({ pool: "scope_closed", nested: "scope_closed" });
		});

		it("fails an async generator created in a scope and resumed from a continuation of that scope later", async () => {
			let generator!: AsyncGenerator<string | null>;
			const outcome = new Promise<{ error?: { code?: string }; value?: unknown }>((resolve) => {
				void tenancy.withOrgContext("org_a", async () => {
					generator = (async function* () {
						yield await settingViaDb();
					})();
					setTimeout(() => {
						generator.next().then(
							(value) => resolve({ value }),
							(error: { code?: string }) => resolve({ error }),
						);
					}, 30);
				});
			});
			const result = await outcome;
			expect(result.value).toBeUndefined();
			expect(result.error?.code).toBe("scope_closed");
		});

		describe("captureOrgScope", () => {
			it("runs later work in a fresh scope of the captured organization, once per call, each on its own client", async () => {
				const runner = await tenancy.withOrgContext("org_a", async () => tenancy.captureOrgScope());
				// The original scope is closed by now.
				const seen = async () => ({ org: tenancy.currentOrgId(), setting: await settingViaDb(), pid: await pid() });
				const first = await runner(seen);
				const second = await runner(seen);
				expect(first).toMatchObject({ org: "org_a", setting: "org_a" });
				expect(second).toMatchObject({ org: "org_a", setting: "org_a" });
				// The client is released and the setting cleared after each call.
				expect(await setting()).toBe("");
				expect(tenancy.currentOrgId()).toBeUndefined();
			});

			it("works from a continuation created in the closed scope", async () => {
				const outcome = new Promise<{ setting?: string | null; error?: { code?: string } }>((resolve) => {
					void tenancy.withOrgContext("org_a", async () => {
						const runner = tenancy.captureOrgScope();
						setTimeout(() => {
							runner(settingViaDb).then(
								(value) => resolve({ setting: value }),
								(error: { code?: string }) => resolve({ error }),
							);
						}, 30);
					});
				});
				expect(await outcome).toEqual({ setting: "org_a" });
			});

			it("also works while the original scope is still open, without holding its client", async () => {
				await tenancy.withOrgContext("org_a", async () => {
					const outer = await pid();
					const runner = tenancy.captureOrgScope();
					const inner = await runner(async () => ({ org: tenancy.currentOrgId(), pid: await pid() }));
					expect(inner.org).toBe("org_a");
					expect(inner.pid).not.toBe(outer);
					expect(await pid()).toBe(outer);
				});
			});

			it("runs unscoped when nothing was captured", async () => {
				const runner = tenancy.captureOrgScope();
				const seen = await runner(async () => ({ org: tenancy.currentOrgId(), setting: await setting() }));
				expect(seen.org).toBeUndefined();
				expect(seen.setting === null || seen.setting === "").toBe(true);
			});
		});

		it("does not let a generator resumed outside any scope see the org's context", async () => {
			const generator = await tenancy.withOrgContext("org_a", async () =>
				(async function* () {
					yield await setting();
				})(),
			);
			// Resumed by the caller, outside the scope: it runs on the global pool with no organization.
			const first = await generator.next();
			expect(first.value === null || first.value === "").toBe(true);
		});
	});

	describe("getPool() inside a scope", () => {
		it("refuses connect() with a clear error and still serves queries", async () => {
			await tenancy.withOrgContext("org_a", async () => {
				expect(() => client.getPool().connect()).toThrowError(/withOrgContext/);
				try {
					client.getPool().connect();
				} catch (error) {
					expect((error as { code?: string }).code).toBe("connect_in_scope");
				}
				expect(await setting()).toBe("org_a");
			});
		});
	});

	it.each(["", "a".repeat(65), "has space", "semi;colon", "quote'", "ünï", "a/b"])(
		"rejects invalid org id %j",
		async (orgId) => {
			await expect(tenancy.withOrgContext(orgId, async () => "x")).rejects.toMatchObject({
				name: "TenancyError",
				code: "invalid_org",
			});
		},
	);

	it("rejects a non-string org id", async () => {
		await expect(tenancy.withOrgContext(undefined as never, async () => "x")).rejects.toMatchObject({
			code: "invalid_org",
		});
	});

	describe("resolveOrgForRequest", () => {
		const userId = `user_${randomUUID()}`;
		const outsider = `user_${randomUUID()}`;
		const memberOrg = `org_${randomUUID()}`;
		const otherOrg = `org_${randomUUID()}`;

		beforeAll(async () => {
			await pools.owner.query(
				`insert into "${schema.name}"."member" (id, organization_id, user_id) values ($1, $2, $3)`,
				[randomUUID(), memberOrg, userId],
			);
		});

		it("returns the active organization of a member", async () => {
			await expect(
				tenancy.resolveOrgForRequest({ session: { userId, activeOrganizationId: memberOrg } }),
			).resolves.toBe(memberOrg);
		});

		it("returns undefined when the user is not a member of the active organization", async () => {
			await expect(
				tenancy.resolveOrgForRequest({ session: { userId, activeOrganizationId: otherOrg } }),
			).resolves.toBeUndefined();
			await expect(
				tenancy.resolveOrgForRequest({ session: { userId: outsider, activeOrganizationId: memberOrg } }),
			).resolves.toBeUndefined();
		});

		it("returns undefined without an active organization or any source", async () => {
			await expect(
				tenancy.resolveOrgForRequest({ session: { userId, activeOrganizationId: null } }),
			).resolves.toBeUndefined();
			await expect(tenancy.resolveOrgForRequest({})).resolves.toBeUndefined();
			await expect(tenancy.resolveOrgForRequest({ session: null, apiKey: null })).resolves.toBeUndefined();
		});

		it("ignores an organization supplied by headers, query or body", async () => {
			const input = {
				session: { userId, activeOrganizationId: memberOrg },
				headers: { "x-organization-id": otherOrg },
				query: { organizationId: otherOrg },
				body: { organizationId: otherOrg },
			};
			await expect(tenancy.resolveOrgForRequest(input as never)).resolves.toBe(memberOrg);
			await expect(
				tenancy.resolveOrgForRequest({
					session: { userId, activeOrganizationId: null },
					headers: { "x-organization-id": memberOrg },
				} as never),
			).resolves.toBeUndefined();
		});

		it("uses the API key's organization after the same membership check", async () => {
			await expect(tenancy.resolveOrgForRequest({ apiKey: { userId, organizationId: memberOrg } })).resolves.toBe(
				memberOrg,
			);
			await expect(
				tenancy.resolveOrgForRequest({ apiKey: { userId, organizationId: otherOrg } }),
			).resolves.toBeUndefined();
			await expect(
				tenancy.resolveOrgForRequest({ apiKey: { userId: outsider, organizationId: memberOrg } }),
			).resolves.toBeUndefined();
			await expect(tenancy.resolveOrgForRequest({ apiKey: { userId, organizationId: null } })).resolves.toBeUndefined();
		});

		it("prefers the key's organization over the session's when both are given", async () => {
			await expect(
				tenancy.resolveOrgForRequest({
					apiKey: { userId, organizationId: null },
					session: { userId, activeOrganizationId: memberOrg },
				}),
			).resolves.toBeUndefined();
		});

		describe("resolveOrgForAuthentication fallback (P1-T04 review 1, M1)", () => {
			const userA = `user_${randomUUID()}`;
			const userB = `user_${randomUUID()}`;
			const noMembership = `user_${randomUUID()}`;
			const orgA = `org_${randomUUID()}`;
			const orgB = `org_${randomUUID()}`;
			const orgA2 = `org_${randomUUID()}`;

			beforeAll(async () => {
				const insert = async (org: string, user: string, createdAt: string) =>
					pools.owner.query(
						`insert into "${schema.name}"."member" (id, organization_id, user_id, created_at) values ($1, $2, $3, $4)`,
						[randomUUID(), org, user, createdAt],
					);
				await insert(orgA, userA, "2026-01-01T00:00:00Z");
				await insert(orgA2, userA, "2026-02-01T00:00:00Z");
				await insert(orgB, userB, "2026-01-01T00:00:00Z");
			});

			it("resolves a bearer token to the owner's oldest membership, never another user's", async () => {
				await expect(tenancy.resolveOrgForAuthentication({ method: "bearer", user: { id: userA } })).resolves.toBe(
					orgA,
				);
				await expect(tenancy.resolveOrgForAuthentication({ method: "bearer", user: { id: userB } })).resolves.toBe(
					orgB,
				);
			});

			it("refuses a bearer token whose user has no membership", async () => {
				await expect(
					tenancy.resolveOrgForAuthentication({ method: "bearer", user: { id: noMembership } }),
				).resolves.toBeUndefined();
			});

			it("resolves an API key without an organization to the owner's oldest membership, or none", async () => {
				await expect(
					tenancy.resolveOrgForAuthentication({ method: "apiKey", apiKeyId: "missing_key", user: { id: userA } }),
				).resolves.toBe(orgA);
				await expect(
					tenancy.resolveOrgForAuthentication({
						method: "apiKey",
						apiKeyId: "missing_key",
						user: { id: noMembership },
					}),
				).resolves.toBeUndefined();
				await expect(
					tenancy.resolveOrgForAuthentication({ method: "apiKey", user: { id: userA } }),
				).resolves.toBeUndefined();
			});

			it("does not fall back for sessions", async () => {
				await expect(
					tenancy.resolveOrgForAuthentication({ method: "session", user: { id: userA }, activeOrganizationId: null }),
				).resolves.toBeUndefined();
			});
		});
	});
});
