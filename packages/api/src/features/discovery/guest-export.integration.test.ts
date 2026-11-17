import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());
const { withOrgContext } = await import("@careeros/tenancy");
const { discoveryService } = await import("./service");
const { discoveryExportSchema } = await import("./schemas");

// P4-T02 (Q226): the guest move and the account export know the discovery tables.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("discovery rows in the guest move and the account export", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		guest: `dg-guest-${run}`,
		member: `dg-member-${run}`,
		guestOrg: `dg-gorg-${run}`,
		memberOrg: `dg-morg-${run}`,
		stranger: `dg-stranger-${run}`,
		strangerOrg: `dg-sorg-${run}`,
	};
	let owner: Pool;
	let app: Pool;

	const job = (
		id: string,
		org: string,
		userId: string,
		externalId: string,
		extra: { source?: string; status?: string } = {},
	) =>
		owner.query(
			`insert into discovered_job (id, organization_id, user_id, job_source_id, source, external_id, board_token, title, company, url, local_score, status)
			 values ($1, $2, $3, $4, 'lever', $5, 'b', 'T', 'C', 'https://example.test/' || $5, 50, $6)`,
			[id, org, userId, extra.source ?? null, externalId, extra.status ?? "new"],
		);

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		for (const org of [ids.guestOrg, ids.memberOrg, ids.strangerOrg])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, true)`,
			[ids.guest],
		);
		for (const id of [ids.member, ids.stranger])
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[id],
			);
		for (const [org, userId] of [
			[ids.guestOrg, ids.guest],
			[ids.memberOrg, ids.member],
			[ids.strangerOrg, ids.stranger],
		] as const)
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`dgm-${org}`,
				org,
				userId,
			]);
	}, 60_000);

	afterAll(async () => {
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [
			[ids.guestOrg, ids.memberOrg, ids.strangerOrg],
		]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[ids.guest, ids.member, ids.stranger]]);
		await Promise.all([owner?.end(), app?.end()]);
	});

	it("moves automations, runs and jobs to the target, keeping the target's copy of a job both have", async () => {
		const src = `dg-src-${run}`;
		const runId = `dg-run-${run}`;
		await owner.query(
			`insert into job_source (id, organization_id, user_id, name) values ($1, $2, $3, 'Guest search')`,
			[src, ids.guestOrg, ids.guest],
		);
		await owner.query(`insert into discovery_run (id, organization_id, job_source_id) values ($1, $2, $3)`, [
			runId,
			ids.guestOrg,
			src,
		]);
		await job(`dg-j1-${run}`, ids.guestOrg, ids.guest, `one-${run}`, { source: src });
		await job(`dg-j2-${run}`, ids.guestOrg, ids.guest, `both-${run}`, { source: src });
		await owner.query(`update discovered_job set first_seen_run_id = $2 where id = $1`, [`dg-j1-${run}`, runId]);
		// The member already dismissed the posting the guest also found.
		await job(`dg-m1-${run}`, ids.memberOrg, ids.member, `both-${run}`, { status: "dismissed" });

		await owner.query(`select careeros_move_guest_discovery($1, $2, $3)`, [ids.guest, ids.member, ids.memberOrg]);

		expect((await owner.query(`select organization_id, user_id from job_source where id = $1`, [src])).rows[0]).toEqual(
			{
				organization_id: ids.memberOrg,
				user_id: ids.member,
			},
		);
		expect((await owner.query(`select organization_id from discovery_run where id = $1`, [runId])).rows[0]).toEqual({
			organization_id: ids.memberOrg,
		});
		const moved = (
			await owner.query(
				`select id, organization_id, user_id, job_source_id, first_seen_run_id, status from discovered_job where external_id like $1 order by id`,
				[`%-${run}`],
			)
		).rows;
		// The guest's copy of the shared posting is gone; the member's dismissed row stays and wins.
		expect(moved.map((row) => row.id)).toEqual([`dg-j1-${run}`, `dg-m1-${run}`]);
		expect(moved[0]).toMatchObject({
			organization_id: ids.memberOrg,
			user_id: ids.member,
			job_source_id: src,
			first_seen_run_id: runId,
		});
		expect(moved[1]).toMatchObject({ status: "dismissed" });
	});

	it("keeps at most 20 automations: those that do not fit stay behind, and their jobs lose the link", async () => {
		const guest2 = `dg-guest2-${run}`;
		const target = `dg-member2-${run}`;
		const gOrg = `dg-gorg2-${run}`;
		const tOrg = `dg-torg2-${run}`;
		for (const org of [gOrg, tOrg])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, true)`,
			[guest2],
		);
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
			[target],
		);
		for (const [org, userId] of [
			[gOrg, guest2],
			[tOrg, target],
		] as const)
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`dgm-${org}`,
				org,
				userId,
			]);
		try {
			await owner.query(
				`insert into job_source (id, organization_id, user_id, name, created_at)
				 select 'dg-t-' || n || '-${run}', $1, $2, 'T' || n, now() - make_interval(secs => n) from generate_series(1, 19) n`,
				[tOrg, target],
			);
			for (const n of [1, 2, 3])
				await owner.query(
					`insert into job_source (id, organization_id, user_id, name, created_at) values ($1, $2, $3, 'G', now() - make_interval(mins => $4))`,
					[`dg-g${n}-${run}`, gOrg, guest2, 10 - n],
				);
			await job(`dg-gj-${run}`, gOrg, guest2, `gj-${run}`, { source: `dg-g3-${run}` });
			await owner.query(`select careeros_move_guest_discovery($1, $2, $3)`, [guest2, target, tOrg]);
			// 19 + 1: the oldest guest automation (g1: created longest ago) fits, the others stay.
			expect(
				(
					await owner.query(`select count(*)::int as n from job_source where organization_id = $1 and user_id = $2`, [
						tOrg,
						target,
					])
				).rows[0],
			).toEqual({ n: 20 });
			const kept = (
				await owner.query(`select organization_id, job_source_id from discovered_job where id = $1`, [`dg-gj-${run}`])
			).rows[0];
			expect(kept).toEqual({ organization_id: tOrg, job_source_id: null });
		} finally {
			await owner.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[gOrg, tOrg]]);
			await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[guest2, target]]);
		}
	});

	it("refuses a source that is not a guest and a target that is not a member", async () => {
		await expect(
			owner.query(`select careeros_move_guest_discovery($1, $2, $3)`, [ids.stranger, ids.member, ids.memberOrg]),
		).rejects.toThrow(/not a guest/);
		await expect(
			owner.query(`select careeros_move_guest_discovery($1, $2, $3)`, [ids.guest, ids.member, ids.strangerOrg]),
		).rejects.toThrow(/not a member/);
	});

	it("is not callable around row-level security by a stranger's organization scope reading the moved rows", async () => {
		const rows = await withDatabasePool(app, () =>
			withOrgContext(ids.strangerOrg, async () => (await app.query(`select id from job_source`)).rows),
		);
		expect(rows).toEqual([]);
	});

	it("exports the caller's automations, runs and jobs without the tenant column or the owner", async () => {
		const src = `dg-xsrc-${run}`;
		await owner.query(`insert into job_source (id, organization_id, user_id, name) values ($1, $2, $3, 'Export me')`, [
			src,
			ids.memberOrg,
			ids.member,
		]);
		await owner.query(`insert into discovery_run (id, organization_id, job_source_id) values ($1, $2, $3)`, [
			`dg-xrun-${run}`,
			ids.memberOrg,
			src,
		]);
		await job(`dg-xjob-${run}`, ids.memberOrg, ids.member, `x-${run}`, { source: src });
		// Another user's row in another organization must not appear.
		await owner.query(`insert into job_source (id, organization_id, user_id, name) values ($1, $2, $3, 'Not yours')`, [
			`dg-other-${run}`,
			ids.strangerOrg,
			ids.stranger,
		]);
		const exported = await withDatabasePool(app, () =>
			withOrgContext(ids.memberOrg, () => discoveryService.exportData(ids.member)),
		);
		const parsed = discoveryExportSchema.parse(exported);
		expect(parsed.automations.map((row) => row.id)).toContain(src);
		expect(parsed.automations.map((row) => row.id)).not.toContain(`dg-other-${run}`);
		expect(parsed.runs.map((row) => row.id)).toContain(`dg-xrun-${run}`);
		expect(parsed.jobs.map((row) => row.id)).toContain(`dg-xjob-${run}`);
		for (const row of [...exported.automations, ...exported.runs, ...exported.jobs]) {
			expect(row).not.toHaveProperty("organizationId");
			expect(row).not.toHaveProperty("userId");
		}
	});
});
