import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createOrgIds, createPools, type TestPools } from "@careeros/testing";
import { isolationRegistry, registerIsolationSuite, runCoverageCheck } from "./index";

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
		]);
	});

	it("covers every table with an organization_id column: registered, RLS on and forced, policy present", async () => {
		const result = await runCoverageCheck(pools.app, isolationRegistry);
		expect(result.failures).toEqual([]);
		expect(result.tenantTables).toEqual(expect.arrayContaining(isolationRegistry.map((entry) => entry.table)));
	});

	// One describe per table: Org B sees none of Org A's rows and Org A sees its own, as careeros_app.
	registerIsolationSuite(isolationRegistry, () => ({ pools, orgA, orgB }));
});
