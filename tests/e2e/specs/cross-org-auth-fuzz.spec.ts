import type { TwoOrgs } from "../fixtures/two-orgs";
import type { AuthOpenApiDocument, AuthOrgAttack, AuthOrgSeed } from "@careeros/testing/auth-org-inventory";
import type { APIRequestContext } from "@playwright/test";
import {
	attacksFor,
	AUTH_ORG_SERVER_ONLY,
	AUTH_ORG_SKIP,
	checkAuthOrgInventory,
	readOrganizationEndpoints,
} from "@careeros/testing/auth-org-inventory";
import { findLeaks, isEmptyResult } from "@careeros/testing/cross-org-inventory";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";
import { createTwoOrgs } from "../fixtures/two-orgs";

// P1-Q10: user B, in Organization B, calls every Better Auth organization endpoint (/api/auth/organization/*) with
// Organization A's ids and slug. B reads nothing of A's, changes nothing, never ends up with A as the active
// organization, and still acts in Organization B afterwards. The endpoints come from the schema that the running auth
// instance publishes (openAPI plugin), so a new endpoint fails the inventory until it is attacked or skipped.

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function call(request: APIRequestContext, attack: AuthOrgAttack) {
	const options = { failOnStatusCode: false, timeout: 20_000 } as const;
	const url = `/api/auth${attack.path}`;
	if (attack.method === "GET") {
		const query = new URLSearchParams(attack.query ?? {});
		const response = await request.get(query.size > 0 ? `${url}?${query}` : url, options);
		return { status: response.status(), text: await response.text() };
	}
	const response = await request.post(url, { ...options, data: attack.body ?? {} });
	return { status: response.status(), text: await response.text() };
}

/** Organization A as user A sees it, through the API and in the tables. */
async function snapshotAuthOrgA(orgs: TwoOrgs): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const id = orgs.a.organizationId;
	for (const path of [
		`get-full-organization?organizationId=${id}`,
		`list-members?organizationId=${id}`,
		`list-invitations?organizationId=${id}`,
	]) {
		const response = await orgs.a.session.get(`/api/auth/organization/${path}`);
		out[`api ${path}`] = `${response.status()} ${await response.text()}`;
	}
	await withSeedPool(async (pool) => {
		const queries: [string, string][] = [
			["organization", "select id, name, slug, logo, metadata from organization where id = $1"],
			["members", "select id, user_id, role from member where organization_id = $1 order by id"],
			[
				"invitations",
				"select id, email, role, status, expires_at, inviter_id from invitation where organization_id = $1 order by id",
			],
		];
		for (const [name, sql] of queries) out[`table ${name}`] = JSON.stringify((await pool.query(sql, [id])).rows);
	});
	return out;
}

test("an organization endpoint never reads, changes or joins Organization A for user B", async ({
	playwright,
	baseURL,
	account,
}, testInfo) => {
	test.setTimeout(90_000);
	const root = String(baseURL ?? testInfo.project.use.baseURL ?? "http://localhost:3000");
	const orgs = await createTwoOrgs(playwright, root, account);
	const failures: string[] = [];

	try {
		const seed: AuthOrgSeed = {
			orgId: orgs.a.organizationId,
			orgSlug: orgs.authOrg.orgSlug,
			ownerUserId: orgs.a.userId,
			ownerMemberId: orgs.authOrg.ownerMemberId,
			memberUserId: orgs.authOrg.memberUserId,
			memberEmail: orgs.authOrg.memberEmail,
			memberId: orgs.authOrg.memberId,
			invitationId: orgs.authOrg.invitationId,
			invitationEmail: orgs.authOrg.invitationEmail,
			bOrgId: orgs.b.organizationId,
			bUserId: orgs.b.userId,
			bMemberId: orgs.authOrg.bMemberId,
			tag: orgs.markers[0]?.replace(/^xorga/, "") ?? "",
		};

		// 1. Inventory: every endpoint the running instance publishes is attacked or on the commented skip list.
		const schema = await orgs.anonymous.get("/api/auth/open-api/generate-schema");
		expect(schema.status(), "the auth instance publishes its schema").toBe(200);
		const endpoints = readOrganizationEndpoints((await schema.json()) as AuthOpenApiDocument);
		expect(endpoints.length, "organization endpoints in the published schema").toBeGreaterThan(15);
		failures.push(...checkAuthOrgInventory(endpoints));

		const keys = [
			...endpoints.map((endpoint) => endpoint.key).filter((key) => !(key in AUTH_ORG_SKIP)),
			...AUTH_ORG_SERVER_ONLY,
		];
		const attacks = [...new Set(keys)].flatMap((key) =>
			(attacksFor(key, seed) ?? []).map((attack) => ({ key, attack })),
		);
		// Reads first, so a leak in a read is still reported if an earlier write took the row away.
		attacks.sort((left, right) => Number(left.attack.method === "POST") - Number(right.attack.method === "POST"));

		const before = await snapshotAuthOrgA(orgs);
		const leakCheck = (text: string) => findLeaks(text, [...orgs.markers, orgs.authOrg.orgName], orgs.foreignIds, []);

		// 2. Control: the same reads as A succeed and the scanner sees A's values in them. Without this, a request that is
		// merely malformed would pass as "refused".
		let controls = 0;
		for (const { key, attack } of attacks) {
			if (
				!/\/(get-organization|get-full-organization|list-members|list-invitations)$/.test(key) ||
				attack.label.includes("slug")
			)
				continue;
			const answer = await call(orgs.a.session, attack);
			if (answer.status !== 200)
				failures.push(`control ${key} (${attack.label}): user A's own call answered ${answer.status}`);
			else if (leakCheck(answer.text).length === 0)
				failures.push(`control ${key} (${attack.label}): the scanner saw nothing of A's`);
			else controls += 1;
		}
		expect(controls, "A's own reads that the scanner recognises").toBeGreaterThanOrEqual(4);

		// 3. B attacks with A's ids and slug.
		for (const { key, attack } of attacks) {
			const label = `${key} (${attack.label})`;
			const { status, text } = await call(orgs.b.session, attack);
			const leaks = leakCheck(text);
			if (leaks.length > 0) failures.push(`${label}: ${status} carries Organization A's ${leaks.join(", ")}`);
			else if (status >= 400 && status < 500) continue;
			else if (status >= 200 && status < 300 && isEmptyResult(parse(text))) continue;
			else failures.push(`${label}: expected 4xx or an empty body, got ${status}: ${text.slice(0, 300)}`);
		}

		// 4. The endpoints that take no id are where a leak would show up as extra rows.
		for (const key of Object.keys(AUTH_ORG_SKIP).filter((item) => item.startsWith("GET "))) {
			const { status, text } = await call(orgs.b.session, { label: "sweep", method: "GET", path: key.slice(4) });
			const leaks = leakCheck(text);
			if (leaks.length > 0) failures.push(`${key} (sweep): ${status} carries Organization A's ${leaks.join(", ")}`);
		}

		// 5. Organization A is unchanged.
		const after = await snapshotAuthOrgA(orgs);
		for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
			if (before[name] !== after[name]) failures.push(`Organization A changed: ${name}`);

		// 6. B's session does not point at Organization A.
		const current = await orgs.b.session.get("/api/auth/get-session?disableCookieCache=true");
		const active = (parse(await current.text()) as { session?: { activeOrganizationId?: string | null } } | null)
			?.session?.activeOrganizationId;
		if (active === orgs.a.organizationId) failures.push("B's session has Organization A as its active organization");
		else if (active && active !== orgs.b.organizationId)
			failures.push(`B's session has an unknown active organization ${active}`);
		await withSeedPool(async (pool) => {
			const { rows } = await pool.query<{ active: string | null }>(
				'select active_organization_id as active from "session" where user_id = $1',
				[orgs.b.userId],
			);
			for (const row of rows)
				if (row.active === orgs.a.organizationId) failures.push("a session row of B has Organization A active");
		});

		// 7. B still acts in Organization B. Better Auth clears a session's active organization when a read names an
		// organization the user is not in (a refusal, not a leak), so B selects its own again first.
		if (!active) {
			console.log("cross-org auth fuzz: a refused request cleared B's active organization; B selects its own again");
			const reselect = await orgs.b.session.post("/api/auth/organization/set-active", {
				data: { organizationId: orgs.b.organizationId },
			});
			expect(reselect.status(), "B selects its own organization").toBe(200);
		}
		const created = await orgs.b.session.post("/api/openapi/resumes", {
			data: { name: `B resume ${seed.tag}`, slug: `xorgb-${seed.tag}`, tags: [] },
		});
		expect(created.status(), "B creates a resume through an oRPC route").toBe(200);
		const resumeId = (await created.json()) as string;
		await withSeedPool(async (pool) => {
			const { rows } = await pool.query<{ organization_id: string }>(
				"select organization_id from resume where id = $1",
				[resumeId],
			);
			expect(rows[0]?.organization_id, "the resume B created belongs to Organization B").toBe(orgs.b.organizationId);
		});

		// 8. API key. B asks for a key bound to Organization A through both creation paths.
		const keyRows = () =>
			withSeedPool(async (pool) => {
				const { rows } = await pool.query<{ id: string; organization_id: string | null }>(
					"select id, organization_id from apikey where reference_id = $1",
					[orgs.b.userId],
				);
				return rows;
			});
		const known = new Set((await keyRows()).map((row) => row.id));
		const created2: { path: string; status: number; key?: string }[] = [];
		for (const [path, data] of [
			[
				"/api/openapi/auth/api-keys",
				{ name: "xorg b to A", expiresIn: null, access: "full", organizationId: orgs.a.organizationId },
			],
			["/api/auth/api-key/create", { name: "xorg b to A (auth)", organizationId: orgs.a.organizationId }],
		] as const) {
			const response = await orgs.b.session.post(path, { data, failOnStatusCode: false });
			const body = parse(await response.text()) as { key?: string } | string;
			created2.push({
				path,
				status: response.status(),
				...(typeof body === "object" && body.key ? { key: body.key } : {}),
			});
		}
		const bound = (await keyRows()).filter((row) => !known.has(row.id));
		const boundToA = bound.filter((row) => row.organization_id === orgs.a.organizationId);
		if (boundToA.length === 0) {
			// Refused, or the field was ignored: no new key is bound to Organization A.
			for (const attempt of created2)
				if (attempt.status >= 200 && attempt.status < 300 && bound.length === 0)
					failures.push(`${attempt.path} answered ${attempt.status} but stored no key`);
		} else {
			// Accepted: a key bound to A must be refused with FORBIDDEN, and carry nothing of A's.
			for (const attempt of created2) {
				if (!attempt.key) continue;
				const keyed = await playwright.request.newContext({
					baseURL: root,
					extraHTTPHeaders: { "x-api-key": attempt.key },
				});
				try {
					for (const path of ["/api/openapi/resumes", "/api/openapi/applications", "/api/openapi/documents"]) {
						const response = await keyed.get(path, { failOnStatusCode: false });
						const text = await response.text();
						if (leakCheck(text).length > 0) failures.push(`key bound to A: GET ${path} carries Organization A's data`);
						if (response.status() !== 403)
							failures.push(`key bound to A: GET ${path} answered ${response.status()}, expected 403`);
					}
				} finally {
					await keyed.dispose();
				}
			}
		}

		console.log(
			`cross-org auth fuzz: ${endpoints.length} organization endpoints, ${attacks.length} requests, ${Object.keys(AUTH_ORG_SKIP).length} skipped, API key paths ${JSON.stringify(created2.map((item) => item.status))}, new keys ${bound.length}, bound to A ${boundToA.length}, bound to B ${bound.filter((row) => row.organization_id === orgs.b.organizationId).length}, unbound ${bound.filter((row) => row.organization_id === null).length}`,
		);
		expect(failures, failures.join("\n")).toEqual([]);
	} finally {
		await orgs.dispose();
	}
});
