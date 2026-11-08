import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createOrgIds, createPools, type TestPools } from "@careeros/testing";
import {
	globalTables,
	isolationRegistry,
	pendingTenantTables,
	registerIsolationSuite,
	runCoverageCheck,
	runUnclassifiedTablesCheck,
	tenancyAllowList,
} from "./index";

// P1-T04: the real registry (the five resume tables) against the migrated public schema, as `careeros_app`.
// Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("the isolation registry on the migrated schema", () => {
	let pools: TestPools;
	const { orgA, orgB } = createOrgIds();

	beforeAll(async () => {
		pools = createPools();
		// Tenant rows reference their organization; the seeds create orgA, this creates orgB for the reads.
		await pools.owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1) ON CONFLICT DO NOTHING`, [
			orgB,
		]);
	});

	afterAll(async () => {
		// Deleting the organizations cascades their tenant rows; the seeded users are removed with their resumes.
		await pools?.owner.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[orgA, orgB]]);
		await pools?.owner.query(`DELETE FROM "user" WHERE id LIKE 'iso-user-%'`);
		// storage_cleanup_job has no foreign key to organization (erasure work outlives it), so it is removed by hand.
		await pools?.owner.query(`DELETE FROM storage_cleanup_job WHERE organization_id = ANY($1::text[])`, [[orgA, orgB]]);
		await pools?.close();
	});

	it("registers the resume, cover letter, application, career and assistant tables", () => {
		expect(isolationRegistry.map((entry) => entry.table)).toEqual([
			"resume",
			"resume_version",
			"resume_slug_redirect",
			"resume_statistics",
			"resume_statistics_daily",
			"cover_letter",
			"cover_letter_version",
			"application",
			"application_lane",
			"application_pipeline",
			"application_profile",
			"career_profile",
			"career_fact",
			"career_story",
			"career_artifact",
			"career_schedule",
			"career_job",
			"career_notification",
			"career_opportunity",
			"career_workspace",
			"career_transcript",
			"career_answer",
			"ai_providers",
			"agent_threads",
			"agent_messages",
			"agent_attachments",
			"agent_actions",
			"ai_content_report",
			"custom_domain",
			"web_access_credentials",
			"storage_cleanup_job",
			"organization_branding",
			"organization_settings",
			"subscription",
			"feature_flag",
			"audit_log",
			"organization_domain",
			"job_source",
			"discovery_run",
			"cohort",
			"discovered_job",
		]);
	});

	it("covers every table with an organization_id column: registered, RLS on and forced, policy present", async () => {
		const result = await runCoverageCheck(pools.app, isolationRegistry);
		expect(result.failures).toEqual([]);
		expect(result.tenantTables).toEqual(expect.arrayContaining(isolationRegistry.map((entry) => entry.table)));
	});

	// P1-T09: every public table is registered, globally allowed, or pending a named ticket. A new table with no
	// decision fails here.
	it("classifies every table in public: registered, global or pending", async () => {
		const result = await runUnclassifiedTablesCheck(pools.app, isolationRegistry);
		expect(result.failures).toEqual([]);
	});

	// P2-Q01: every Phase 2 table has a decision, and each one exists in the migrated schema. The tenant tables are
	// registered (RLS and isolation checks run on them); the pre-authentication handoff table and the Cloudflare cleanup
	// queue are the two deliberate exceptions, each on a list with its reason. Nothing is left pending.
	it("accounts for every Phase 2 table and leaves the pending list empty", async () => {
		const registered = new Set(isolationRegistry.map((entry) => entry.table));
		const allowed = new Set(tenancyAllowList.map((entry) => entry.table));
		const global = new Set(globalTables.map((entry) => entry.table));
		for (const table of ["organization_branding", "organization_settings", "organization_domain"])
			expect(registered.has(table), `${table} is registered`).toBe(true);
		expect(allowed.has("auth_handoff"), "auth_handoff is on the tenancy allow-list").toBe(true);
		expect(global.has("organization_domain_cf_cleanup"), "the Cloudflare cleanup queue is a global table").toBe(true);
		for (const reason of [...tenancyAllowList, ...globalTables].filter((entry) =>
			["auth_handoff", "organization_domain_cf_cleanup"].includes(entry.table),
		))
			expect(reason.reason.length, `${reason.table} has a reason`).toBeGreaterThan(20);

		const { rows } = await pools.owner.query<{ table_name: string }>(
			`select table_name from information_schema.tables
			 where table_schema = 'public' and table_name = any($1::text[])`,
			[
				[
					"organization_branding",
					"organization_settings",
					"organization_domain",
					"organization_domain_cf_cleanup",
					"auth_handoff",
				],
			],
		);
		expect(rows.map((row) => row.table_name).sort()).toEqual([
			"auth_handoff",
			"organization_branding",
			"organization_domain",
			"organization_domain_cf_cleanup",
			"organization_settings",
		]);
		// CAREEROS (P3-T01): subscription, feature_flag and audit_log are registered; plan is a global table.
		const registeredNames = new Set(isolationRegistry.map((entry) => entry.table));
		for (const table of ["subscription", "feature_flag", "audit_log"])
			expect(registeredNames.has(table), `${table} is registered`).toBe(true);
		expect(globalTables.map((entry) => entry.table)).toContain("plan");
		expect(pendingTenantTables).toEqual([]);
	});

	it("fails a table nobody classified", async () => {
		const result = await runUnclassifiedTablesCheck(pools.app, isolationRegistry.slice(1));
		expect(result.failures).toContain(
			"public.resume: is not in the isolation registry, the global allow-list or the pending set",
		);
	});

	// One describe per table: Org B sees none of Org A's rows and Org A sees its own, as careeros_app.
	registerIsolationSuite(isolationRegistry, () => ({ pools, orgA, orgB }));
});
