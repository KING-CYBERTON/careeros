import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";
import sharp from "sharp";
import { withDatabasePool } from "@reactive-resume/db/client";

// Real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

// P2-T01: branding and settings behind row-level security, as the `careeros_app` role (NOBYPASSRLS), on a database of
// its own with every migration applied. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const LEGACY_ORG = "brand-legacy";

describe.skipIf(!configured)("organization branding and settings", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `brand-a-${run}`,
		orgB: `brand-b-${run}`,
		ownerA: `brand-owner-a-${run}`,
		adminA: `brand-admin-a-${run}`,
		memberA: `brand-member-a-${run}`,
		ownerB: `brand-owner-b-${run}`,
		outsider: `brand-outsider-${run}`,
	};
	let owner: Pool;
	let app: Pool;
	let database: IsolatedTestDatabase;
	const storage = new Map<string, Uint8Array>();
	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const count = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);

	let branding: typeof import("./router").brandingRouter;
	let settings: typeof import("./router").settingsRouter;
	let service: typeof import("./service");

	const asUser = (userId: string, organizationId: string | null) => ({
		authentication: {
			user: { id: userId },
			method: "session" as const,
			permissions: ["read", "write", "delete"] as const,
			activeOrganizationId: organizationId,
		},
		reqHeaders: new Headers(),
		locale: "en-US",
	});
	const anonymous = { authentication: null, reqHeaders: new Headers(), locale: "en-US" };
	// oRPC types the context from the procedure; the test contexts are structurally what the adapters build.
	const invoke = <T>(procedure: unknown, input: unknown, context: unknown): Promise<T> =>
		inApp(() => call(procedure as never, input as never, { context: context as never })) as Promise<T>;

	const png = (color: string) =>
		sharp({ create: { width: 8, height: 8, channels: 4, background: color } })
			.png()
			.toBuffer();
	const upload = (name: string, data: BlobPart, type: string) => ({ file: new File([data], name, { type }) });

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("brand_t01", {
			// The organization exists before the migration that adds the tables: the backfill must give it rows.
			onMigration: async ({ directory, phase }, client) => {
				if (phase === "before" && directory.endsWith("_organization_branding"))
					await client.query(`INSERT INTO organization (id, name, slug) VALUES ($1, 'Legacy', $1)`, [LEGACY_ORG]);
			},
		});
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const [org, users] of [
			[
				ids.orgA,
				[
					[ids.ownerA, "owner"],
					[ids.adminA, "admin"],
					[ids.memberA, "member"],
				],
			],
			[ids.orgB, [[ids.ownerB, "owner"]]],
		] as const) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			for (const [user, role] of users) {
				await owner.query(
					`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
					[user],
				);
				await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
					user,
					org,
					role,
				]);
			}
		}
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
			[ids.outsider],
		);
		const { configureStorageService } = await import("../storage/service");
		configureStorageService({
			list: async (prefix: string) => [...storage.keys()].filter((key) => key === prefix),
			read: async (key: string) => {
				const data = storage.get(key);
				return data ? { data, size: data.byteLength } : null;
			},
			write: async ({ key, data }: { key: string; data: Uint8Array }) => {
				storage.set(key, data);
			},
			delete: async (key: string) => storage.delete(key),
			healthcheck: async () => ({ status: "healthy", type: "local", message: "Synthetic storage" }),
		} as never);
		({ brandingRouter: branding, settingsRouter: settings } = await import("./router"));
		service = await import("./service");
	});

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("rows exist for every organization", () => {
		it("backfills organizations that existed before the migration, with defaults", async () => {
			const { rows } = await owner.query(`SELECT * FROM organization_branding WHERE organization_id = $1`, [
				LEGACY_ORG,
			]);
			expect(rows).toHaveLength(1);
			for (const [column, value] of Object.entries(rows[0])) {
				if (column === "organization_id") expect(value).toBe(LEGACY_ORG);
				else if (column !== "updated_at") expect(value, column).toBeNull();
			}
			const settingsRows = await owner.query(
				`SELECT open_signup FROM organization_settings WHERE organization_id = $1`,
				[LEGACY_ORG],
			);
			expect(settingsRows.rows).toEqual([{ open_signup: false }]);
		});

		it("creates both rows when an organization is created, whatever role inserts it", async () => {
			for (const id of [ids.orgA, ids.orgB]) {
				expect(await count(`SELECT count(*) AS n FROM organization_branding WHERE organization_id = $1`, [id])).toBe(1);
				expect(await count(`SELECT count(*) AS n FROM organization_settings WHERE organization_id = $1`, [id])).toBe(1);
			}
			// The careeros_app role cannot read the tables without a context, but its insert still fires the trigger.
			const viaApp = `brand-app-${run}`;
			await app.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [viaApp]);
			expect(await count(`SELECT count(*) AS n FROM organization_branding WHERE organization_id = $1`, [viaApp])).toBe(
				1,
			);
			expect(await count(`SELECT count(*) AS n FROM organization_settings WHERE organization_id = $1`, [viaApp])).toBe(
				1,
			);
			await owner.query(`DELETE FROM organization WHERE id = $1`, [viaApp]);
			expect(await count(`SELECT count(*) AS n FROM organization_branding WHERE organization_id = $1`, [viaApp])).toBe(
				0,
			);
		});

		it("never overwrites existing rows when the same organization is inserted again", async () => {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1) ON CONFLICT DO NOTHING`, [
				ids.orgA,
			]);
			expect(
				await count(`SELECT count(*) AS n FROM organization_branding WHERE organization_id = $1`, [ids.orgA]),
			).toBe(1);
		});
	});

	describe("row-level security", () => {
		it("hides both tables without an organization and between organizations", async () => {
			expect((await app.query(`SELECT count(*)::int AS n FROM organization_branding`)).rows[0].n).toBe(0);
			expect((await app.query(`SELECT count(*)::int AS n FROM organization_settings`)).rows[0].n).toBe(0);
			for (const table of ["organization_branding", "organization_settings"]) {
				const client = await app.connect();
				try {
					await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [ids.orgB]);
					const { rows } = await client.query(`SELECT organization_id FROM ${table}`);
					expect(rows).toEqual([{ organization_id: ids.orgB }]);
					const update = await client.query(`UPDATE ${table} SET updated_at = now() WHERE organization_id = $1`, [
						ids.orgA,
					]);
					expect(update.rowCount).toBe(0);
					await expect(
						client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [ids.orgA]),
					).resolves.toMatchObject({
						rowCount: 0,
					});
					await expect(
						client.query(`UPDATE ${table} SET organization_id = $1 WHERE organization_id = $2`, [ids.orgA, ids.orgB]),
					).rejects.toMatchObject({ code: "42501" });
				} finally {
					await client.query(`SELECT set_config('app.current_org_id', '', false)`);
					client.release();
				}
			}
		});

		it("refuses an insert for another organization", async () => {
			const client = await app.connect();
			try {
				await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [ids.orgB]);
				await client.query(`DELETE FROM organization_settings WHERE organization_id = $1`, [ids.orgB]);
				await expect(
					client.query(`INSERT INTO organization_settings (organization_id) VALUES ($1)`, [ids.orgA]),
				).rejects.toMatchObject({ code: "42501" });
				await expect(
					client.query(`INSERT INTO organization_branding (organization_id) VALUES ($1)`, [ids.orgA]),
				).rejects.toMatchObject({ code: "42501" });
			} finally {
				await client.query(`SELECT set_config('app.current_org_id', '', false)`);
				client.release();
			}
			await owner.query(`INSERT INTO organization_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
				ids.orgB,
			]);
		});

		it("enforces the colour, font and https CHECK constraints in the database", async () => {
			const bad: [string, string][] = [
				["primary_color", "red"],
				["secondary_color", "#12345"],
				["font", "Comic Sans MS"],
				["support_url", "http://acme.example"],
				["terms_url", "javascript:alert(1)"],
				["privacy_url", "ftp://acme.example"],
			];
			for (const [column, value] of bad)
				await expect(
					owner.query(`UPDATE organization_branding SET ${column} = $1 WHERE organization_id = $2`, [value, ids.orgA]),
					column,
				).rejects.toMatchObject({ code: "23514" });
		});

		it("deletes both rows with the organization", async () => {
			const id = `brand-gone-${run}`;
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [id]);
			await owner.query(`DELETE FROM organization WHERE id = $1`, [id]);
			expect(await count(`SELECT count(*) AS n FROM organization_settings WHERE organization_id = $1`, [id])).toBe(0);
		});
	});

	describe("roles", () => {
		it("lets any member read the branding and only an owner or admin read the settings", async () => {
			await expect(invoke(branding.get, undefined, asUser(ids.memberA, ids.orgA))).resolves.toMatchObject({
				appName: null,
				logoUrl: null,
			});
			await expect(invoke(settings.get, undefined, asUser(ids.memberA, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(invoke(settings.get, undefined, asUser(ids.adminA, ids.orgA))).resolves.toMatchObject({
				openSignup: false,
			});
		});

		it("refuses a member and accepts an admin and an owner, writing the actor", async () => {
			const input = { appName: "Acme" };
			await expect(invoke(branding.update, input, asUser(ids.memberA, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(await count(`SELECT count(*) AS n FROM organization_branding WHERE app_name IS NOT NULL`)).toBe(0);
			await expect(
				invoke(branding.update, { ...input, primaryColor: "#AABBCC", font: "Lora" }, asUser(ids.adminA, ids.orgA)),
			).resolves.toMatchObject({ appName: "Acme", primaryColor: "#aabbcc", font: "Lora" });
			await expect(
				invoke(branding.update, { appName: "Acme Co" }, asUser(ids.ownerA, ids.orgA)),
			).resolves.toMatchObject({
				appName: "Acme Co",
				primaryColor: "#aabbcc",
			});
			const { rows } = await owner.query(`SELECT updated_by FROM organization_branding WHERE organization_id = $1`, [
				ids.orgA,
			]);
			expect(rows[0].updated_by).toBe(ids.ownerA);
		});

		it("resets a field with null and leaves omitted ones alone", async () => {
			await invoke(branding.update, { primaryColor: null }, asUser(ids.ownerA, ids.orgA));
			await expect(invoke(branding.get, undefined, asUser(ids.memberA, ids.orgA))).resolves.toMatchObject({
				appName: "Acme Co",
				primaryColor: null,
				font: "Lora",
			});
		});

		it("rejects invalid input before it reaches the database", async () => {
			for (const input of [{ primaryColor: "blue" }, { font: "Papyrus" }, { supportUrl: "http://acme.example" }])
				await expect(invoke(branding.update, input, asUser(ids.ownerA, ids.orgA))).rejects.toMatchObject({
					code: "BAD_REQUEST",
				});
		});

		it("updates settings only for an owner or admin, and only in their own organization", async () => {
			await expect(invoke(settings.update, { openSignup: true }, asUser(ids.memberA, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(invoke(settings.update, { openSignup: true }, asUser(ids.adminA, ids.orgA))).resolves.toMatchObject({
				openSignup: true,
			});
			expect(
				await count(`SELECT count(*) AS n FROM organization_settings WHERE organization_id = $1 AND open_signup`, [
					ids.orgB,
				]),
			).toBe(0);
		});

		it("does not let a user act on an organization they do not belong to", async () => {
			// The organization comes from the session after a membership check, never from the client.
			await expect(invoke(branding.update, { appName: "Hijack" }, asUser(ids.ownerB, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(invoke(branding.get, undefined, asUser(ids.outsider, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(invoke(branding.get, undefined, asUser(ids.ownerB, ids.orgB))).resolves.toMatchObject({
				appName: null,
			});
		});
	});

	describe("public lookup", () => {
		it("returns only the public fields, by id and by slug, to the app role without a context", async () => {
			await invoke(
				branding.update,
				{
					emailFromName: "Acme Careers Team",
					supportUrl: "https://acme.example/help",
					privacyUrl: "https://acme.example/privacy",
				},
				asUser(ids.ownerA, ids.orgA),
			);
			const bySlug = await app.query(`SELECT * FROM careeros_public_branding_by_slug($1)`, [ids.orgA]);
			const byId = await app.query(`SELECT * FROM careeros_public_branding($1)`, [ids.orgA]);
			expect(bySlug.rows).toEqual(byId.rows);
			expect(bySlug.rows).toHaveLength(1);
			expect(Object.keys(bySlug.rows[0]).sort()).toEqual(
				[
					"organization_id",
					"slug",
					"app_name",
					"logo_storage_key",
					"favicon_storage_key",
					"primary_color",
					"secondary_color",
					"font",
					"support_url",
					"terms_url",
					"privacy_url",
				].sort(),
			);
			expect(bySlug.rows[0]).toMatchObject({ app_name: "Acme Co", support_url: "https://acme.example/help" });
			expect(JSON.stringify(bySlug.rows)).not.toContain("Acme Careers Team");
			expect(JSON.stringify(bySlug.rows)).not.toContain(ids.ownerA);
		});

		it("returns no row for an unknown organization", async () => {
			expect((await app.query(`SELECT * FROM careeros_public_branding('nope-${run}')`)).rows).toEqual([]);
			expect((await app.query(`SELECT * FROM careeros_public_branding_by_slug('nope-${run}')`)).rows).toEqual([]);
			await expect(invoke(branding.publicBySlug, { slug: `nope-${run}` }, anonymous)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("answers the public procedure without a session and never reveals the sender name or settings", async () => {
			const result = await invoke<Record<string, unknown>>(branding.publicBySlug, { slug: ids.orgA }, anonymous);
			expect(result).toMatchObject({ organizationId: ids.orgA, slug: ids.orgA, appName: "Acme Co", font: "Lora" });
			expect(Object.keys(result)).not.toEqual(expect.arrayContaining(["emailFromName"]));
			expect(JSON.stringify(result)).not.toContain("Acme Careers Team");
			expect(result).not.toHaveProperty("openSignup");
			expect(result).not.toHaveProperty("updatedBy");
		});

		it("is not executable by PUBLIC", async () => {
			const { rows } = await owner.query(
				`SELECT has_function_privilege('careeros_app', 'public.careeros_public_branding(text)', 'EXECUTE') AS app,
				        has_function_privilege('public', 'public.careeros_public_branding(text)', 'EXECUTE') AS pub,
				        has_function_privilege('public', 'public.careeros_public_branding_by_slug(text)', 'EXECUTE') AS pub_slug`,
			);
			expect(rows[0]).toEqual({ app: true, pub: false, pub_slug: false });
		});
	});

	describe("uploads", () => {
		it("stores a logo under orgs/<org>/branding/ and serves only the current file", async () => {
			const first = await invoke<{ url: string; contentType: string }>(
				branding.uploadLogo,
				upload("logo.png", await png("#336699"), "image/png"),
				asUser(ids.adminA, ids.orgA),
			);
			expect(first.contentType).toBe("image/png");
			expect(first.url).toMatch(new RegExp(`/api/branding-assets/${ids.orgA}/logo-[0-9a-f-]{36}\\.png$`));
			const { rows } = await owner.query(
				`SELECT logo_storage_key FROM organization_branding WHERE organization_id = $1`,
				[ids.orgA],
			);
			const oldKey = rows[0].logo_storage_key as string;
			expect(oldKey.startsWith(`orgs/${ids.orgA}/branding/logo-`)).toBe(true);
			expect(storage.has(oldKey)).toBe(true);
			const filename = oldKey.split("/").pop() ?? "";
			await expect(inApp(() => service.getPublicBrandingAsset(ids.orgA, filename))).resolves.toBe(oldKey);
			await expect(inApp(() => service.getPublicBrandingAsset(ids.orgB, filename))).resolves.toBeNull();

			// Replacing the logo queues the old file for cleanup, and the immediate pass removes it.
			const second = await invoke<{ url: string }>(
				branding.uploadLogo,
				upload("logo2.png", await png("#993366"), "image/png"),
				asUser(ids.ownerA, ids.orgA),
			);
			expect(second.url).not.toBe(first.url);
			expect(storage.has(oldKey)).toBe(false);
			await expect(inApp(() => service.getPublicBrandingAsset(ids.orgA, filename))).resolves.toBeNull();
			expect(await count(`SELECT count(*) AS n FROM storage_cleanup_job WHERE organization_id = $1`, [ids.orgA])).toBe(
				0,
			);
			const current = await owner.query(
				`SELECT logo_storage_key FROM organization_branding WHERE organization_id = $1`,
				[ids.orgA],
			);
			expect(storage.has(current.rows[0].logo_storage_key)).toBe(true);
		});

		it("keeps the cleanup job when the storage delete fails, owned by the organization", async () => {
			const { rows } = await owner.query(
				`SELECT logo_storage_key FROM organization_branding WHERE organization_id = $1`,
				[ids.orgA],
			);
			const doomed = rows[0].logo_storage_key as string;
			const { getStorageService } = await import("../storage/service");
			const original = getStorageService().delete;
			getStorageService().delete = async () => {
				throw new Error("storage unavailable");
			};
			try {
				await invoke(
					branding.uploadLogo,
					upload("logo3.png", await png("#112233"), "image/png"),
					asUser(ids.ownerA, ids.orgA),
				);
			} finally {
				getStorageService().delete = original;
			}
			const jobs = await owner.query(
				`SELECT owner_id, storage_key FROM storage_cleanup_job WHERE organization_id = $1`,
				[ids.orgA],
			);
			expect(jobs.rows).toEqual([{ owner_id: ids.orgA, storage_key: doomed }]);
			await owner.query(`DELETE FROM storage_cleanup_job WHERE organization_id = $1`, [ids.orgA]);
		});

		it("accepts a PNG or ICO favicon and a sanitized SVG logo", async () => {
			const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
			await expect(
				invoke(branding.uploadFavicon, upload("f.ico", ico, "image/x-icon"), asUser(ids.ownerA, ids.orgA)),
			).resolves.toMatchObject({ contentType: "image/x-icon" });
			await expect(
				invoke(
					branding.uploadFavicon,
					upload("f.png", await png("#000000"), "image/png"),
					asUser(ids.ownerA, ids.orgA),
				),
			).resolves.toMatchObject({ contentType: "image/png" });
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#336699"/></svg>`;
			const stored = await invoke<{ url: string }>(
				branding.uploadLogo,
				upload("logo.svg", svg, "image/svg+xml"),
				asUser(ids.ownerA, ids.orgA),
			);
			expect(stored.url).toMatch(/\.svg$/);
		});

		it("rejects types and sizes outside the limits, and unsafe SVG, without touching the row or storage", async () => {
			const before = [...storage.keys()].sort();
			const rowBefore = (
				await owner.query(
					`SELECT logo_storage_key, favicon_storage_key FROM organization_branding WHERE organization_id = $1`,
					[ids.orgA],
				)
			).rows[0];
			const as = asUser(ids.ownerA, ids.orgA);
			const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } })
				.gif()
				.toBuffer();
			const rejected: [unknown, unknown][] = [
				[branding.uploadLogo, upload("l.gif", gif, "image/gif")],
				[branding.uploadLogo, upload("l.png", new Uint8Array(512 * 1024 + 1), "image/png")],
				[branding.uploadLogo, upload("l.png", "<html>not an image</html>", "image/png")],
				[
					branding.uploadLogo,
					upload("l.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "image/svg+xml"),
				],
				[
					branding.uploadFavicon,
					upload(
						"f.webp",
						await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } })
							.webp()
							.toBuffer(),
						"image/webp",
					),
				],
				[branding.uploadFavicon, upload("f.png", new Uint8Array(128 * 1024 + 1), "image/png")],
				[branding.uploadFavicon, upload("f.svg", `<svg xmlns="http://www.w3.org/2000/svg"></svg>`, "image/svg+xml")],
			];
			for (const [procedure, input] of rejected)
				await expect(invoke(procedure, input, as)).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect([...storage.keys()].sort()).toEqual(before);
			expect(
				(
					await owner.query(
						`SELECT logo_storage_key, favicon_storage_key FROM organization_branding WHERE organization_id = $1`,
						[ids.orgA],
					)
				).rows[0],
			).toEqual(rowBefore);
		});

		it("refuses an upload from a member before reading the file", async () => {
			const before = storage.size;
			await expect(
				invoke(branding.uploadLogo, upload("l.png", await png("#336699"), "image/png"), asUser(ids.memberA, ids.orgA)),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				invoke(
					branding.uploadFavicon,
					upload("f.png", await png("#336699"), "image/png"),
					asUser(ids.memberA, ids.orgA),
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(storage.size).toBe(before);
		});

		it("never touches another organization's branding", async () => {
			const rows = await owner.query(
				`SELECT organization_id, logo_storage_key FROM organization_branding WHERE organization_id = $1`,
				[ids.orgB],
			);
			expect(rows.rows).toEqual([{ organization_id: ids.orgB, logo_storage_key: null }]);
		});
	});
});
