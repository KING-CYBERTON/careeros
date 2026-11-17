import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { captureOrgScope, withOrgContext } from "@careeros/tenancy";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { linkAnonymousAccount } from "@reactive-resume/auth/config";
import { bindGlobalPoolForTesting, withDatabasePool } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { aiProvidersRouter } from "../ai-providers/router";
import { encryptCredential } from "../ai/credentials";
import { reportAiContent } from "../ai/reports";
import { authRouter } from "../auth/router";
import { careerRouter } from "../career/router";
import { loadDocument } from "./document";
import { agentRouter } from "./router";
import { reapStaleAgentRunsAtBoot } from "./runs";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// P1-T08: the assistant and AI tables through the real routers, as the `careeros_app` role (NOBYPASSRLS), against the
// migrated public schema. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const TABLES = [
	"ai_providers",
	"agent_threads",
	"agent_messages",
	"agent_attachments",
	"agent_actions",
	"ai_content_report",
];
const KEY = "encrypted_api_key, api_key_salt, api_key_hash, api_key_preview";
// A letter's style is the resume's basics, picture and metadata, plus the ids of its sender block and body.
const letterStyle = () => {
	const { basics, picture, metadata } = defaultResumeData;
	const { notes: _notes, layout: _layout, ...style } = metadata;
	return JSON.stringify({ basics, picture, metadata: style, sectionId: "letter", itemId: "body" });
};

describe.skipIf(!configured)("assistant and AI tables, the assistant's tools and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `ag-org-a-${run}`,
		orgB: `ag-org-b-${run}`,
		orgG: `ag-org-g-${run}`,
		orgT: `ag-org-t-${run}`,
		userA: `ag-user-a-${run}`,
		// A member of both organizations: its own data in each is what separates the two.
		userAB: `ag-user-ab-${run}`,
		guest: `ag-guest-${run}`,
		guest2: `ag-guest2-${run}`,
		target: `ag-target-${run}`,
		resumeA: `ag-resume-a-${run}`,
		resumeB: `ag-resume-b-${run}`,
		letterB: `ag-letter-b-${run}`,
		appB: `ag-app-b-${run}`,
		providerA: `ag-provider-a-${run}`,
		providerB: `ag-provider-b-${run}`,
		threadA: `ag-thread-a-${run}`,
		threadB: `ag-thread-b-${run}`,
	};
	let owner: Pool;
	let app: Pool;
	// CAREEROS (P1-Q09): its own database, so no other file's cleanup, purge or migration replay can touch these rows.
	let database: IsolatedTestDatabase;
	let restoreGlobalPool: (() => void) | undefined;

	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const user = (id: string) => ({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const context = (userId: string, activeOrganizationId: string) => ({
		locale: "en-US" as const,
		reqHeaders: new Headers(),
		resHeaders: new Headers(),
		authentication: {
			user: user(userId),
			method: "session" as const,
			permissions: ["read", "write", "delete"] as ("read" | "write" | "delete")[],
			activeOrganizationId,
		},
	});
	const providersFor = (userId: string, orgId: string) =>
		createRouterClient(aiProvidersRouter, { context: context(userId, orgId) });
	const agentFor = (userId: string, orgId: string) =>
		createRouterClient(agentRouter, { context: context(userId, orgId) });
	const careerFor = (userId: string, orgId: string) =>
		createRouterClient(careerRouter, { context: context(userId, orgId) });
	const authFor = (userId: string, orgId: string) =>
		createRouterClient(authRouter, { context: context(userId, orgId) });
	const reportFor = (userId: string, orgId: string) =>
		createRouterClient({ report: reportAiContent }, { context: context(userId, orgId) });
	const rowCount = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);
	const provider = (id: string, orgId: string, userId: string, extra = "") => {
		const key = encryptCredential("sk-fixture-key-1234567890");
		return owner.query(
			`INSERT INTO ai_providers (id, organization_id, user_id, label, provider, model, ${KEY}, enabled, test_status${extra ? ", is_default" : ""})
			 VALUES ($1, $2, $3, 'Fixture', 'openai', 'fixture-model', $4, $5, $6, $7, true, 'success'${extra ? ", true" : ""})`,
			[id, orgId, userId, key.encryptedApiKey, key.apiKeySalt, key.apiKeyHash, key.apiKeyPreview],
		);
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("agent_tenancy");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		// The assistant's tools leave the request scope (captureOrgScope) and then use the global pool: point it here too.
		restoreGlobalPool = bindGlobalPoolForTesting(app);
		await owner.query(
			`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2), ($3, 'G', $3), ($4, 'T', $4)`,
			[ids.orgA, ids.orgB, ids.orgG, ids.orgT],
		);
		for (const id of [ids.userA, ids.userAB, ids.guest, ids.guest2, ids.target]) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, $2)`,
				[id, id.startsWith("ag-guest")],
			);
		}
		const members: [string, string, string, string][] = [
			["m-a", ids.orgA, ids.userA, "2026-01-01"],
			["m-ab-a", ids.orgA, ids.userAB, "2026-01-01"],
			["m-ab-b", ids.orgB, ids.userAB, "2026-01-02"],
			["m-g", ids.orgG, ids.guest, "2026-01-01"],
			["m-g2", ids.orgG, ids.guest2, "2026-01-01"],
			["m-t", ids.orgT, ids.target, "2026-01-01"],
		];
		for (const [id, org, userId, createdAt] of members)
			await owner.query(
				`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)`,
				[`${id}-${run}`, org, userId, createdAt],
			);
		// userAB's documents: a resume in each organization, and a letter and an application in B.
		await owner.query(
			`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ($1, 'In A', 'a', $6, $2, $3), ($4, 'In B', 'b', $6, $2, $5)`,
			[ids.resumeA, ids.userAB, ids.orgA, ids.resumeB, ids.orgB, JSON.stringify(defaultResumeData)],
		);
		await owner.query(
			`INSERT INTO cover_letter (id, name, style, user_id, organization_id) VALUES ($1, 'Letter in B', $4, $2, $3)`,
			[ids.letterB, ids.userAB, ids.orgB, letterStyle()],
		);
		await owner.query(
			`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'B Co', 'Engineer')`,
			[ids.appB, ids.orgB, ids.userAB],
		);
		// A tested, switched-on connection in each organization, the one in A its default; and a conversation in each.
		await provider(ids.providerA, ids.orgA, ids.userAB, "default");
		await provider(ids.providerB, ids.orgB, ids.userAB);
		await owner.query(
			`INSERT INTO agent_threads (id, organization_id, user_id, ai_provider_id, working_resume_id, source_resume_id, title)
			 VALUES ($1, $2, $3, $4, $5, $5, 'Thread in A'), ($6, $7, $3, $8, NULL, NULL, 'Secret thread in B')`,
			[ids.threadA, ids.orgA, ids.userAB, ids.providerA, ids.resumeA, ids.threadB, ids.orgB, ids.providerB],
		);
		await owner.query(
			`INSERT INTO agent_messages (id, organization_id, user_id, thread_id, role, sequence, ui_message) VALUES ($1, $2, $3, $4, 'user', 0, '{"id":"m","role":"user","parts":[]}')`,
			[`ag-msg-b-${run}`, ids.orgB, ids.userAB, ids.threadB],
		);
		await owner.query(
			`INSERT INTO agent_attachments (id, organization_id, user_id, thread_id, storage_key, filename, media_type, size) VALUES ($1, $2, $3, $4, $1, 'secret.txt', 'text/plain', 1)`,
			[`ag-att-b-${run}`, ids.orgB, ids.userAB, ids.threadB],
		);
		await owner.query(
			`INSERT INTO agent_actions (id, organization_id, user_id, thread_id, kind, title, operations, base_updated_at, applied_updated_at) VALUES ($1, $2, $3, $4, 'resume_patch', 'Secret edit', '[]', now(), now())`,
			[`ag-act-b-${run}`, ids.orgB, ids.userAB, ids.threadB],
		);
	}, 60_000);

	afterAll(async () => {
		restoreGlobalPool?.();
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("two organizations", () => {
		it("keep each organization's connections and conversations to themselves, with a default in each", async () => {
			const inA = await inApp(() => providersFor(ids.userAB, ids.orgA).list({}));
			const inB = await inApp(() => providersFor(ids.userAB, ids.orgB).list({}));
			expect(inA.map((p) => p.id)).toEqual([ids.providerA]);
			expect(inB.map((p) => p.id)).toEqual([ids.providerB]);
			// The tenant column is not part of the API surface.
			expect(inA[0]).not.toHaveProperty("organizationId");

			// The same user can have a default connection in each organization, and setting one touches only its own.
			await inApp(() => providersFor(ids.userAB, ids.orgB).setDefault({ id: ids.providerB }));
			expect(
				(await owner.query(`SELECT id, is_default FROM ai_providers WHERE user_id = $1 ORDER BY id`, [ids.userAB]))
					.rows,
			).toEqual([
				{ id: ids.providerA, is_default: true },
				{ id: ids.providerB, is_default: true },
			]);
			const defaults = await owner.query(
				`SELECT 1 FROM ai_providers WHERE organization_id = $1 AND user_id = $2 AND is_default`,
				[ids.orgA, ids.userAB],
			);
			expect(defaults.rowCount).toBe(1);

			const threadsA = await inApp(() => agentFor(ids.userAB, ids.orgA).threads.list({}));
			const threadsB = await inApp(() => agentFor(ids.userAB, ids.orgB).threads.list({}));
			expect(threadsA.map((t) => t.id)).toEqual([ids.threadA]);
			expect(threadsB.map((t) => t.id)).toEqual([ids.threadB]);
			expect(threadsA[0]).not.toHaveProperty("organizationId");
			// A member of neither organization's data sees nothing of the other's.
			expect(await inApp(() => agentFor(ids.userA, ids.orgA).threads.list({}))).toEqual([]);
			await expect(inApp(() => agentFor(ids.userAB, ids.orgA).threads.get({ id: ids.threadB }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("answer NOT_FOUND for a connection of the other organization, on every procedure", async () => {
			const a = providersFor(ids.userAB, ids.orgA);
			await expect(inApp(() => a.update({ id: ids.providerB, label: "Hijack" }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(inApp(() => a.setDefault({ id: ids.providerB }))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => a.test({ id: ids.providerB }))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await inApp(() => a.delete({ id: ids.providerB }));
			expect(await rowCount(`SELECT count(*) AS n FROM ai_providers WHERE id = $1`, [ids.providerB])).toBe(1);
			expect((await owner.query(`SELECT label FROM ai_providers WHERE id = $1`, [ids.providerB])).rows).toEqual([
				{ label: "Fixture" },
			]);
		});

		it("creates a connection in the active organization only", async () => {
			const created = await inApp(() =>
				providersFor(ids.userA, ids.orgA).create({
					label: "Mine",
					provider: "openai",
					model: "m",
					apiKey: "sk-test-key-12345",
				}),
			);
			expect(created).not.toHaveProperty("organizationId");
			expect((await owner.query(`SELECT organization_id FROM ai_providers WHERE id = $1`, [created.id])).rows).toEqual([
				{ organization_id: ids.orgA },
			]);
			expect((await inApp(() => providersFor(ids.userAB, ids.orgB).list({}))).map((p) => p.id)).toEqual([
				ids.providerB,
			]);
		});
	});

	describe("references into another organization", () => {
		it("are refused when a conversation is started, with NOT_FOUND", async () => {
			const a = agentFor(ids.userAB, ids.orgA);
			await expect(
				inApp(() => a.threads.start({ resumeId: ids.resumeB, aiProviderId: ids.providerA })),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				inApp(() => a.threads.start({ coverLetterId: ids.letterB, aiProviderId: ids.providerA })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => a.threads.start({ resumeId: ids.resumeA, aiProviderId: ids.providerB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => a.threads.start({ scope: "application", applicationId: ids.appB, aiProviderId: ids.providerA })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => a.threads.update({ id: ids.threadA, aiProviderId: ids.providerB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect((await owner.query(`SELECT ai_provider_id FROM agent_threads WHERE id = $1`, [ids.threadA])).rows).toEqual(
				[{ ai_provider_id: ids.providerA }],
			);
			// And the same start in its own organization works, and carries the organization.
			const started = await inApp(() => a.threads.start({ resumeId: ids.resumeA, aiProviderId: ids.providerA }));
			expect(started).not.toHaveProperty("organizationId");
			expect((await owner.query(`SELECT organization_id FROM agent_threads WHERE id = $1`, [started.id])).rows).toEqual(
				[{ organization_id: ids.orgA }],
			);
		});

		it("are refused by the database for every writer (composite foreign keys), and by a schedule's connection", async () => {
			const refused = (sql: string, params: unknown[]) =>
				expect(owner.query(sql, params)).rejects.toMatchObject({ code: "23503" });
			await refused(
				`INSERT INTO agent_threads (id, organization_id, user_id, ai_provider_id, title) VALUES ($1, $2, $3, $4, 'x')`,
				[`ag-x1-${run}`, ids.orgA, ids.userAB, ids.providerB],
			);
			await refused(
				`INSERT INTO agent_threads (id, organization_id, user_id, working_resume_id, title) VALUES ($1, $2, $3, $4, 'x')`,
				[`ag-x2-${run}`, ids.orgA, ids.userAB, ids.resumeB],
			);
			await refused(
				`INSERT INTO agent_threads (id, organization_id, user_id, cover_letter_id, title) VALUES ($1, $2, $3, $4, 'x')`,
				[`ag-x3-${run}`, ids.orgA, ids.userAB, ids.letterB],
			);
			await refused(
				`INSERT INTO agent_threads (id, organization_id, user_id, application_id, scope, title) VALUES ($1, $2, $3, $4, 'application', 'x')`,
				[`ag-x4-${run}`, ids.orgA, ids.userAB, ids.appB],
			);
			await refused(
				`INSERT INTO agent_actions (id, organization_id, user_id, thread_id, resume_id, kind, title, operations, base_updated_at, applied_updated_at)
				 VALUES ($1, $2, $3, $4, $5, 'resume_patch', 'x', '[]', now(), now())`,
				[`ag-x5-${run}`, ids.orgA, ids.userAB, ids.threadA, ids.resumeB],
			);
			await refused(
				`INSERT INTO agent_messages (id, organization_id, user_id, thread_id, role, sequence, ui_message) VALUES ($1, $2, $3, $4, 'user', 5, '{}')`,
				[`ag-x6-${run}`, ids.orgA, ids.userAB, ids.threadB],
			);
			await refused(
				`INSERT INTO career_schedule (id, organization_id, user_id, kind, query, next_run_at, ai_provider_id) VALUES ($1, $2, $3, 'discovery', 'q', now(), $4)`,
				[`ag-x7-${run}`, ids.orgA, ids.userAB, ids.providerB],
			);

			// The same through the career router (Q48): the schedule may name only a connection of its own organization.
			const schedule = {
				kind: "discovery" as const,
				query: "platform engineer",
				enabled: false,
				nextRunAt: new Date(Date.now() + 86_400_000),
				timezone: "UTC",
			};
			await expect(
				inApp(() => careerFor(ids.userAB, ids.orgA).saveSchedule({ ...schedule, aiProviderId: ids.providerB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			const saved = await inApp(() =>
				careerFor(ids.userAB, ids.orgA).saveSchedule({ ...schedule, aiProviderId: ids.providerA }),
			);
			expect(saved.aiProviderId).toBe(ids.providerA);

			// Deleting a document clears only the link; the conversation keeps its organization.
			await owner.query(
				`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ($1, 'Temp', 'tmp', '{}', $2, $3)`,
				[`ag-tmp-${run}`, ids.userAB, ids.orgA],
			);
			await owner.query(
				`INSERT INTO agent_threads (id, organization_id, user_id, working_resume_id, title) VALUES ($1, $2, $3, $4, 'Temp')`,
				[`ag-tmp-thread-${run}`, ids.orgA, ids.userAB, `ag-tmp-${run}`],
			);
			await owner.query(`DELETE FROM resume WHERE id = $1`, [`ag-tmp-${run}`]);
			expect(
				(
					await owner.query(`SELECT organization_id, working_resume_id FROM agent_threads WHERE id = $1`, [
						`ag-tmp-thread-${run}`,
					])
				).rows,
			).toEqual([{ organization_id: ids.orgA, working_resume_id: null }]);
		});
	});

	describe("a request without an organization", () => {
		it("sees no row in any of the six tables, as careeros_app", async () => {
			await owner.query(
				`INSERT INTO ai_content_report (id, organization_id, user_id, source, reason, content, note) VALUES ($1, $2, $3, 'other', 'other', 'c', '')`,
				[`ag-rep-none-${run}`, ids.orgA, ids.userA],
			);
			for (const table of TABLES) {
				expect(await rowCount(`SELECT count(*) AS n FROM ${table}`)).toBeGreaterThan(0);
				const { rows } = await app.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
				expect(Number(rows[0]?.n), table).toBe(0);
			}
		});
	});

	describe("content reports", () => {
		it("belong to the reporter's active organization, export for that organization only, and go with the account", async () => {
			const receipt = await inApp(() =>
				reportFor(ids.userAB, ids.orgA).report({
					source: "assistant",
					reason: "other",
					content: "Fictional report",
					note: "",
				}),
			);
			expect(
				(await owner.query(`SELECT organization_id, user_id FROM ai_content_report WHERE id = $1`, [receipt.id])).rows,
			).toEqual([{ organization_id: ids.orgA, user_id: ids.userAB }]);
			const exportedA = await inApp(() => authFor(ids.userAB, ids.orgA).exportData({}));
			expect(exportedA.aiContentReports.map((r) => r.id)).toContain(receipt.id);
			expect(exportedA.aiContentReports[0]).not.toHaveProperty("organizationId");
			expect(exportedA.career.threads.map((t) => t.id)).toEqual(expect.arrayContaining([ids.threadA]));
			expect(exportedA.career.threads.map((t) => t.id)).not.toContain(ids.threadB);
			expect(exportedA.career.threads[0]).not.toHaveProperty("organizationId");
			const exportedB = await inApp(() => authFor(ids.userAB, ids.orgB).exportData({}));
			expect(exportedB.aiContentReports.map((r) => r.id)).not.toContain(receipt.id);
			expect(exportedB.career.threads.map((t) => t.id)).toEqual([ids.threadB]);

			// Account deletion removes the user's reports whatever the organization (the cascade is not subject to RLS).
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[`ag-doomed-${run}`],
			);
			await owner.query(
				`INSERT INTO ai_content_report (id, organization_id, user_id, source, reason, content, note) VALUES ($1, $2, $3, 'other', 'other', 'c', '')`,
				[`ag-doomed-rep-${run}`, ids.orgB, `ag-doomed-${run}`],
			);
			await inApp(() => app.query(`DELETE FROM "user" WHERE id = $1`, [`ag-doomed-${run}`]));
			expect(
				await rowCount(`SELECT count(*) AS n FROM ai_content_report WHERE user_id = $1`, [`ag-doomed-${run}`]),
			).toBe(0);
		});
	});

	describe("the assistant's tools", () => {
		it("read and edit only the active organization's documents, also after the request scope has ended", async () => {
			// What the tools run: `loadDocument` (read_resume, read_letter, propose_edits), wrapped in the organization scope
			// captured when the reply started.
			const readInA = await inApp(() =>
				withOrgContext(ids.orgA, async () => {
					const inScope = captureOrgScope();
					return { inScope };
				}),
			);
			const own = await inApp(() =>
				readInA.inScope(() => loadDocument(ids.userAB, { kind: "resume", id: ids.resumeA })),
			);
			expect(own.name).toBe("In A");
			await expect(
				inApp(() => readInA.inScope(() => loadDocument(ids.userAB, { kind: "resume", id: ids.resumeB }))),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => readInA.inScope(() => loadDocument(ids.userAB, { kind: "letter", id: ids.letterB }))),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			// The other organization's scope reads the other organization's document, and not the first one's.
			const inB = await inApp(() =>
				withOrgContext(ids.orgB, async () => {
					const scope = captureOrgScope();
					return scope(() => loadDocument(ids.userAB, { kind: "resume", id: ids.resumeB }));
				}),
			);
			expect(inB.name).toBe("In B");
			await expect(
				inApp(() => withOrgContext(ids.orgB, () => loadDocument(ids.userAB, { kind: "resume", id: ids.resumeA }))),
			).rejects.toMatchObject({ code: "NOT_FOUND" });

			// The conversation's attachments and messages are scoped the same way.
			await expect(
				inApp(() => agentFor(ids.userAB, ids.orgA).attachments.delete({ id: `ag-none-${run}` })),
			).resolves.toBeUndefined();
			await expect(
				inApp(() =>
					agentFor(ids.userAB, ids.orgA).messages.send({
						threadId: ids.threadB,
						message: { id: "x", role: "user", parts: [{ type: "text", text: "hi" }] } as never,
					}),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	describe("assistant replies at boot", () => {
		it("clear the stale run claims of every organization, each inside its own", async () => {
			const stale = [ids.orgA, ids.orgB].map((org, index) => ({ org, id: `ag-stale-${index}-${run}` }));
			for (const { org, id } of stale)
				await owner.query(
					`INSERT INTO agent_threads (id, organization_id, user_id, title, active_run_id, active_stream_id, active_run_started_at)
					 VALUES ($1, $2, $3, 'Stale', 'run-x', 'stream-x', now() - interval '1 hour')`,
					[id, org, ids.userAB],
				);
			await inApp(() => reapStaleAgentRunsAtBoot());
			for (const { id } of stale)
				expect((await owner.query(`SELECT active_run_id FROM agent_threads WHERE id = $1`, [id])).rows).toEqual([
					{ active_run_id: null },
				]);
			// The definer function answers with organization ids only.
			await owner.query(`UPDATE agent_threads SET active_run_id = 'run-y' WHERE id = $1`, [stale[0]?.id]);
			const { rows } = await app.query(`SELECT * FROM careeros_orgs_with_active_agent_runs()`);
			expect(rows.map((row) => Object.values(row)[0])).toContain(ids.orgA);
		});
	});

	describe("guest linking", () => {
		const seedGuest = async (guestId: string, label: string) => {
			const resume = `ag-g-resume-${label}-${run}`;
			const thread = `ag-g-thread-${label}-${run}`;
			const managed = `server-ai:${ids.orgG}:${guestId}`;
			await owner.query(
				`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ($1, 'Guest resume', $2, '{}', $3, $4)`,
				[resume, `g-${label}-${run}`, guestId, ids.orgG],
			);
			await provider(`ag-g-provider-${label}-${run}`, ids.orgG, guestId, "default");
			await owner.query(
				`INSERT INTO ai_providers (id, organization_id, user_id, label, provider, model, ${KEY}, enabled, test_status, is_default)
				 VALUES ($1, $2, $3, 'Server AI', 'openai', 'm', '', '', '', '', true, 'success', false)`,
				[managed, ids.orgG, guestId],
			);
			await owner.query(
				`INSERT INTO agent_threads (id, organization_id, user_id, ai_provider_id, working_resume_id, title) VALUES ($1, $2, $3, $4, $5, 'Guest chat')`,
				[thread, ids.orgG, guestId, managed, resume],
			);
			await owner.query(
				`INSERT INTO agent_messages (id, organization_id, user_id, thread_id, role, sequence, ui_message) VALUES ($1, $2, $3, $4, 'user', 0, '{}')`,
				[`ag-g-msg-${label}-${run}`, ids.orgG, guestId, thread],
			);
			await owner.query(
				`INSERT INTO agent_attachments (id, organization_id, user_id, thread_id, message_id, storage_key, filename, media_type, size)
				 VALUES ($1, $2, $3, $4, $5, $6, 'n.txt', 'text/plain', 1)`,
				[
					`ag-g-att-${label}-${run}`,
					ids.orgG,
					guestId,
					thread,
					`ag-g-msg-${label}-${run}`,
					`uploads/${guestId}/agent/${thread}/a`,
				],
			);
			await owner.query(
				`INSERT INTO agent_actions (id, organization_id, user_id, thread_id, message_id, resume_id, kind, title, operations, base_updated_at, applied_updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'resume_patch', 't', '[]', now(), now())`,
				[`ag-g-act-${label}-${run}`, ids.orgG, guestId, thread, `ag-g-msg-${label}-${run}`, resume],
			);
			await owner.query(
				`INSERT INTO ai_content_report (id, organization_id, user_id, source, reason, content, note) VALUES ($1, $2, $3, 'other', 'other', 'c', '')`,
				[`ag-g-rep-${label}-${run}`, ids.orgG, guestId],
			);
			return { resume, thread, managed };
		};

		it("moves connections, conversations and reports to the account's organization, with one default and its own server connection", async () => {
			const { resume, thread, managed } = await seedGuest(ids.guest, "one");
			// The account already has a default connection and a server connection in its organization.
			await provider(`ag-t-provider-${run}`, ids.orgT, ids.target, "default");
			const targetManaged = `server-ai:${ids.orgT}:${ids.target}`;
			await owner.query(
				`INSERT INTO ai_providers (id, organization_id, user_id, label, provider, model, ${KEY}, enabled, test_status)
				 VALUES ($1, $2, $3, 'Server AI', 'openai', 'm', '', '', '', '', true, 'success')`,
				[targetManaged, ids.orgT, ids.target],
			);
			await inApp(() => linkAnonymousAccount({ fromUserId: ids.guest, toUserId: ids.target }));
			const moved = async (table: string, id: string) =>
				(await owner.query(`SELECT user_id, organization_id FROM ${table} WHERE id = $1`, [id])).rows;
			const expected = [{ user_id: ids.target, organization_id: ids.orgT }];
			expect(await moved("resume", resume)).toEqual(expected);
			expect(await moved("agent_threads", thread)).toEqual(expected);
			expect(await moved("agent_messages", `ag-g-msg-one-${run}`)).toEqual(expected);
			expect(await moved("agent_attachments", `ag-g-att-one-${run}`)).toEqual(expected);
			expect(await moved("agent_actions", `ag-g-act-one-${run}`)).toEqual(expected);
			expect(await moved("ai_providers", `ag-g-provider-one-${run}`)).toEqual(expected);
			expect(await moved("ai_content_report", `ag-g-rep-one-${run}`)).toEqual(expected);
			// The guest's server connection is gone; the thread points at the account's own.
			expect(await rowCount(`SELECT count(*) AS n FROM ai_providers WHERE id = $1`, [managed])).toBe(0);
			expect(
				(await owner.query(`SELECT ai_provider_id, working_resume_id FROM agent_threads WHERE id = $1`, [thread])).rows,
			).toEqual([{ ai_provider_id: targetManaged, working_resume_id: resume }]);
			expect(
				(await owner.query(`SELECT storage_key FROM agent_attachments WHERE id = $1`, [`ag-g-att-one-${run}`])).rows,
			).toEqual([{ storage_key: `uploads/${ids.target}/agent/${thread}/a` }]);
			// The guest's default yielded to the account's.
			expect(
				(
					await owner.query(`SELECT id FROM ai_providers WHERE organization_id = $1 AND user_id = $2 AND is_default`, [
						ids.orgT,
						ids.target,
					])
				).rows,
			).toEqual([{ id: `ag-t-provider-${run}` }]);
		});

		it("refuses a source that is not a guest and a target organization the user is not in", async () => {
			await expect(
				app.query(`SELECT careeros_move_guest_agent($1, $2, $3)`, [ids.userA, ids.target, ids.orgT]),
			).rejects.toMatchObject({ message: expect.stringContaining("not a guest") });
			await expect(
				app.query(`SELECT careeros_move_guest_agent($1, $2, $3)`, [ids.guest2, ids.target, ids.orgA]),
			).rejects.toMatchObject({ message: expect.stringContaining("not a member") });
			await seedGuest(ids.guest2, "two");
			await expect(
				app.query(`SELECT careeros_move_guest_agent($1, $2, NULL)`, [ids.guest2, ids.target]),
			).rejects.toMatchObject({ message: expect.stringContaining("no organization") });
			expect(await rowCount(`SELECT count(*) AS n FROM agent_threads WHERE user_id = $1`, [ids.guest2])).toBe(1);
		});
	});
});
