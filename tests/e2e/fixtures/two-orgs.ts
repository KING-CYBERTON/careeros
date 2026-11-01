import type { E2EAccount } from "./data";
import type { SeedIds } from "@careeros/testing/cross-org-inventory";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { startAiStub } from "./ai-stub";
import { createInviteeAccount, deleteE2EOrganizations } from "./careeros-org";
import { deleteE2EUser } from "./db";
import { withSeedPool } from "./seed-db";

// CareerOS (P1-Q03): two users in two organizations, with one of everything seeded in Organization A.
// Accounts and organizations are made through the real sign-up flow; every row is created through the public API,
// except the few that no endpoint can create without an AI run or DNS (see seedRowsWithoutEndpoint).

type Playwright = PlaywrightWorkerArgs["playwright"];

export type Party = {
	account: E2EAccount;
	userId: string;
	organizationId: string;
	/** Signed in with the session cookie. */
	session: APIRequestContext;
};

export type TwoOrgs = {
	baseURL: string;
	a: Party;
	b: Party;
	/** Organization B's API key, and a request context that sends only that key. */
	bApiKey: string;
	bKeyed: APIRequestContext;
	/** A request context with neither cookie nor key. */
	anonymous: APIRequestContext;
	ids: SeedIds;
	aResume: { username: string; slug: string; name: string };
	/** Text that appears only in Organization A's rows. */
	markers: string[];
	/** Every id of Organization A's rows, for scanning responses. */
	foreignIds: string[];
	dispose: () => Promise<void>;
};

async function expectOk(response: APIResponse, what: string) {
	if (response.ok()) return;
	throw new Error(`Seeding ${what} failed with ${response.status()}: ${(await response.text()).slice(0, 400)}`);
}

async function json<T = unknown>(response: APIResponse, what: string): Promise<T> {
	await expectOk(response, what);
	return (await response.json()) as T;
}

async function signUp(playwright: Playwright, baseURL: string, account: E2EAccount) {
	const session = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
	const response = await session.post("/api/auth/sign-up/email", {
		headers: { referer: `${baseURL}/auth/register` },
		data: {
			name: account.name,
			email: account.email,
			password: account.password,
			username: account.username,
			displayUsername: account.username,
			callbackURL: "/dashboard",
		},
	});
	await expectOk(response, `sign-up of ${account.username}`);
	const current = await json<{ session: { userId: string; activeOrganizationId?: string | null } }>(
		await session.get("/api/auth/get-session"),
		"session",
	);
	let organizationId = current.session.activeOrganizationId ?? "";
	if (!organizationId) {
		const list = await json<{ id: string }[]>(await session.get("/api/auth/organization/list"), "organizations");
		organizationId = list[0]?.id ?? "";
	}
	if (!organizationId) throw new Error(`${account.username} has no organization after sign-up`);
	return { account, userId: current.session.userId, organizationId, session } satisfies Party;
}

/** Rows that no endpoint can create here: a discovered opportunity, a notice, a voice transcript, a custom domain. */
async function seedRowsWithoutEndpoint(a: Party, tag: string) {
	const ids = {
		opportunity: `xorga-opportunity-${tag}`,
		notification: `xorga-notice-${tag}`,
		transcript: `xorga-voice-${tag}`,
	};
	await withSeedPool(async (pool) => {
		await pool.query(
			`insert into career_opportunity (id, organization_id, user_id, url, role, company, location, snippet, description)
			 values ($1, $2, $3, $4, $5, $6, 'Remote', $7, $7)`,
			[
				ids.opportunity,
				a.organizationId,
				a.userId,
				`https://example.test/xorga-${tag}`,
				`Xorga${tag} engineer`,
				`Xorga${tag} Company`,
				`Xorga${tag} snippet`,
			],
		);
		await pool.query(
			`insert into career_notification (id, organization_id, user_id, key, notice)
			 values ($1, $2, $3, $4, $5::jsonb)`,
			[ids.notification, a.organizationId, a.userId, `xorga-${tag}`, JSON.stringify({ title: `Xorga${tag} notice` })],
		);
		await pool.query(
			`insert into career_transcript (id, organization_id, user_id, original, edited, model)
			 values ($1, $2, $3, $4, $4, 'stub')`,
			[ids.transcript, a.organizationId, a.userId, `Xorga${tag} transcript`],
		);
		// Custom domains are switched off on the e2e server (no 412-free endpoint), so the row goes in directly.
		await pool.query(
			`insert into custom_domain (organization_id, user_id, hostname, verification_token)
			 values ($1, $2, $3, $4) on conflict do nothing`,
			[a.organizationId, a.userId, `xorga-${tag}.example.test`, `xorga${tag}token`],
		);
	});
	return ids;
}

export async function createTwoOrgs(playwright: Playwright, baseURL: string, owner: E2EAccount): Promise<TwoOrgs> {
	const tag = Date.now().toString(36);
	const accountA: E2EAccount = {
		...owner,
		name: `Xorga${tag} User`,
		email: `xorga${tag}_a@example.test`,
		username: `xorga${tag}_a`,
	};
	// B's name must not contain A's marker, or B's own profile would read as a leak.
	const accountB = createInviteeAccount({ ...accountA, username: `xorgb${tag}` });
	const stub = await startAiStub();
	let a: Party | undefined;
	let b: Party | undefined;
	let bKeyed: APIRequestContext | undefined;
	let anonymous: APIRequestContext | undefined;
	const dispose = async () => {
		await bKeyed?.dispose();
		await anonymous?.dispose();
		await a?.session.dispose();
		await b?.session.dispose();
		await stub.close();
		await deleteE2EOrganizations([accountA, accountB]);
		await deleteE2EUser(accountA);
		await deleteE2EUser(accountB);
	};

	try {
		a = await signUp(playwright, baseURL, accountA);
		b = await signUp(playwright, baseURL, accountB);
		const api = (path: string) => `/api/openapi${path}`;
		const text = (what: string) => `Xorga${tag} ${what}`;

		// Organization B's API key, used for the "keyed" pass.
		const created = await json<{ key: string }>(
			await b.session.post(api("/auth/api-keys"), { data: { name: "xorg b", expiresIn: null, access: "full" } }),
			"B's API key",
		);
		const keyed = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-api-key": created.key } });
		const open = await playwright.request.newContext({ baseURL });
		bKeyed = keyed;
		anonymous = open;

		// Organization A's own API key (so the key routes have an id to attack).
		await expectOk(
			await a.session.post(api("/auth/api-keys"), { data: { name: text("key"), expiresIn: null, access: "full" } }),
			"A's API key",
		);
		const aKeys = await json<{ apiKeys: { id: string }[] }>(await a.session.get(api("/auth/api-keys")), "A's API keys");
		const apiKey = aKeys.apiKeys[0]?.id;
		if (!apiKey) throw new Error("A's API key has no id");

		// Resume, shared publicly, with a version and recorded statistics.
		const slug = `xorga-${tag}`;
		const resume = await json<string>(
			await a.session.post(api("/resumes"), { data: { name: text("resume"), slug, tags: [text("tag")] } }),
			"resume",
		);
		await expectOk(await a.session.put(api(`/resumes/${resume}`), { data: { isPublic: true } }), "resume share");
		await expectOk(
			await a.session.post(api(`/resumes/${resume}/versions`), { data: { name: text("resume version") } }),
			"resume version",
		);
		const resumeVersions = await json<{ id: string }[]>(
			await a.session.get(api(`/resumes/${resume}/versions`)),
			"versions",
		);
		const resumeVersion = resumeVersions[0]?.id;
		await open.get(`/${accountA.username}/${slug}`);
		await open.post(api(`/resumes/${accountA.username}/${slug}/statistics/download`));

		// Cover letter and version.
		const letterCreated = await json<{ id?: string }>(
			await a.session.post(api("/cover-letters"), {
				data: { name: text("letter"), content: `<p>${text("letter body")}</p>` },
			}),
			"cover letter",
		);
		const letter = letterCreated.id ?? "";
		await expectOk(
			await a.session.post(api(`/cover-letters/${letter}/versions`), { data: { name: text("letter version") } }),
			"letter version",
		);
		const letterVersions = await json<{ id: string }[]>(
			await a.session.get(api(`/cover-letters/${letter}/versions`)),
			"versions",
		);
		const letterVersion = letterVersions[0]?.id;

		// Lane and application, with a note and an interview on its timeline.
		const lanes = await json<{ revision: number }>(await a.session.get(api("/applications/lanes")), "lanes");
		const laneResult = await json<{ lanes: { id: string; label: string | null }[] }>(
			await a.session.post(api("/applications/lanes"), {
				data: { expectedRevision: lanes.revision, label: text("lane"), category: "screening", color: "#112233" },
			}),
			"lane",
		);
		const lane = laneResult.lanes.find((candidate) => candidate.label === text("lane"))?.id ?? "";
		const application = await json<string>(
			await a.session.post(api("/applications"), {
				data: {
					company: text("Company"),
					role: text("Role"),
					laneId: lane,
					resumeId: resume,
					coverLetterId: letter,
					jobDescription: text("posting"),
				},
			}),
			"application",
		);
		await expectOk(
			await a.session.post(api(`/applications/${application}/notes`), { data: { text: text("note") } }),
			"note",
		);
		await expectOk(
			await a.session.post(api(`/applications/${application}/interviews`), {
				data: { kind: "technical", at: new Date(Date.now() + 2 * 86_400_000).toISOString(), timezone: "Europe/Berlin" },
			}),
			"interview",
		);
		const detail = await json<{ activity?: { id: string; type?: string }[] }>(
			await a.session.get(api(`/applications/${application}`)),
			"application detail",
		);
		const timeline = detail.activity ?? [];
		const interview = timeline.find((entry) => entry.type === "interview")?.id ?? "";
		const timelineEntry = timeline.find((entry) => entry.type === "note")?.id ?? "";

		await expectOk(
			await a.session.put(api("/application-profile"), {
				data: { data: { givenName: text("given") }, expectedRevision: null },
			}),
			"application profile",
		);

		// Career: profile, fact, story, schedule, answer, workspace, saved offer.
		await expectOk(
			await a.session.put(api("/career/profile"), { data: { targetRoles: [text("role")] } }),
			"career profile",
		);
		const fact = await json<{ id: string }>(
			await a.session.post(api("/career/facts"), {
				data: { text: text("fact"), category: "skill", source: { kind: "manual", id: "x", quote: text("quote") } },
			}),
			"fact",
		);
		const story = await json<{ id: string }>(
			await a.session.post(api("/career/stories"), {
				data: { title: text("story"), situation: "s", task: "t", action: "a", result: "r", factIds: [fact.id] },
			}),
			"story",
		);
		const schedule = await json<{ id: string }>(
			await a.session.post(api("/career/schedules"), {
				data: {
					applicationId: application,
					kind: "follow-up",
					query: text("query"),
					nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
					timezone: "Europe/Berlin",
				},
			}),
			"schedule",
		);
		const answer = await json<{ id: string }>(
			await a.session.post(api("/career/answers"), {
				data: {
					applicationId: application,
					question: text("question"),
					answer: text("answer"),
					source: "manual",
					scope: "application",
					factIds: [],
					storyIds: [],
					expectedEvidence: [],
					reviewed: true,
					noEmployerWording: false,
				},
			}),
			"answer",
		);
		await expectOk(
			await a.session.patch(api(`/career/workspace/${application}`), {
				data: { message: text("workspace"), expected: { message: "" } },
			}),
			"workspace",
		);
		const offer = await json<{ id: string }>(
			await a.session.post(api("/career/offers"), {
				data: { currency: "EUR", period: "year", base: 1000, variable: null, applicationId: application },
			}),
			"offer",
		);

		// AI provider (tested against the local stub so it is enabled), web access, agent thread, message, attachment.
		const provider = await json<{ id: string }>(
			await a.session.post(api("/ai-providers"), {
				data: {
					label: text("provider"),
					provider: "openai-compatible",
					model: "stub",
					baseURL: stub.baseURL,
					apiKey: "stub-key",
				},
			}),
			"provider",
		);
		await expectOk(await a.session.post(api(`/ai-providers/${provider.id}/test`)), "provider test");
		await expectOk(
			await a.session.put(api("/integrations/web-access"), {
				data: { provider: "tavily", apiKey: "synthetic-never-sent" },
			}),
			"web access",
		);
		const thread = await json<{ id: string }>(
			await a.session.post(api("/agent/threads"), { data: { scope: "application", applicationId: application } }),
			"thread",
		);
		await a.session.post(api("/agent/messages/send"), {
			data: {
				threadId: thread.id,
				message: { id: `xorga-${tag}`, role: "user", parts: [{ type: "text", text: text("message") }] },
			},
		});
		const threadDetail = await json<{ messages?: { id: string }[] }>(
			await a.session.get(api(`/agent/threads/${thread.id}`)),
			"thread",
		);
		const message = threadDetail.messages?.[0]?.id ?? "";
		const attachment = await json<{ id: string }>(
			await a.session.post(api("/agent/attachments"), {
				data: {
					threadId: thread.id,
					filename: `xorga-${tag}.txt`,
					mediaType: "text/plain",
					data: Buffer.from(text("attachment")).toString("base64"),
				},
			}),
			"attachment",
		);

		const extra = await seedRowsWithoutEndpoint(a, tag);

		const ids: SeedIds = {
			resume,
			resumeVersion: resumeVersion ?? "",
			letter,
			letterVersion: letterVersion ?? "",
			application,
			lane,
			timelineEntry,
			interview,
			provider: provider.id,
			thread: thread.id,
			message,
			attachment: attachment.id,
			fact: fact.id,
			story: story.id,
			schedule: schedule.id,
			answer: answer.id,
			opportunity: extra.opportunity,
			notification: extra.notification,
			savedItem: offer.id,
			transcript: extra.transcript,
			apiKey,
		};
		const missing = Object.entries(ids).filter(([, value]) => !value);
		if (missing.length > 0)
			throw new Error(`Seeding left these ids empty: ${missing.map(([name]) => name).join(", ")}`);

		return {
			baseURL,
			a,
			b,
			bApiKey: created.key,
			bKeyed: keyed,
			anonymous: open,
			ids,
			aResume: { username: accountA.username, slug, name: text("resume") },
			markers: [`xorga${tag}`],
			foreignIds: [...new Set(Object.values(ids)), a.organizationId, a.userId],
			dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots of Organization A, taken as user A.

/** Every read that returns something of Organization A's, through A's own session. */
export function snapshotPaths(ids: SeedIds, username: string, slug: string): string[] {
	return [
		`/resumes/${ids.resume}`,
		`/resumes/${ids.resume}/versions`,
		`/resumes/${ids.resume}/statistics`,
		`/resumes/${username}/${slug}`,
		"/resumes",
		`/cover-letters/${ids.letter}`,
		`/cover-letters/${ids.letter}/versions`,
		"/cover-letters",
		"/applications/lanes",
		`/applications/${ids.application}`,
		"/applications",
		"/application-profile",
		"/career/profile",
		"/career/facts",
		"/career/stories",
		"/career/schedules",
		"/career/answers",
		"/career/opportunities",
		"/career/notifications",
		"/career/saved",
		"/career/voice/transcripts",
		`/career/workspace/${ids.application}`,
		"/ai-providers",
		`/agent/threads/${ids.thread}`,
		"/agent/threads",
		"/integrations/web-access",
		"/auth/api-keys",
		"/documents",
	];
}

export async function snapshotOrgA(orgs: TwoOrgs): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const path of snapshotPaths(orgs.ids, orgs.aResume.username, orgs.aResume.slug)) {
		const response = await orgs.a.session.get(`/api/openapi${path}`);
		out[path] = `${response.status()} ${await response.text()}`;
	}
	// The rows themselves, so a change the API would not show (or a deletion) is still seen.
	await withSeedPool(async (pool) => {
		const { rows: tables } = await pool.query<{ table_name: string }>(
			`select table_name from information_schema.columns
			 where table_schema = 'public' and column_name = 'organization_id' order by 1`,
		);
		for (const { table_name } of tables) {
			if (["member", "invitation"].includes(table_name)) continue;
			const { rows } = await pool.query<{ digest: string }>(
				`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from "${table_name}" t where organization_id = $1`,
				[orgs.a.organizationId],
			);
			out[`table ${table_name}`] = rows[0]?.digest ?? "";
		}
	});
	return out;
}
