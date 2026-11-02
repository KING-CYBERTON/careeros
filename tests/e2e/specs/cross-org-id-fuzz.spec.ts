import type { TwoOrgs } from "../fixtures/two-orgs";
import type { BuiltRequest, McpTool, OpenApiDocument, Operation } from "@careeros/testing/cross-org-inventory";
import type { APIRequestContext } from "@playwright/test";
import {
	buildMcpArguments,
	buildRequest,
	findLeaks,
	ITEM_IDS_ONLY,
	MCP_ALLOW,
	isEmptyResult,
	NO_TENANT_ID,
	OVERRIDES,
	readOperations,
} from "@careeros/testing/cross-org-inventory";
import { ORG_HOST_PATTERN, orgHostsConfigured } from "../fixtures/org-hosts";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";
import { createTwoOrgs, snapshotOrgA } from "../fixtures/two-orgs";

// P1-Q03: an id from Organization A, presented in an Organization B session, never returns A's data or changes it.
// Every procedure the server publishes is read from its generated OpenAPI document (which the server builds from
// the oRPC router object), so a new procedure that takes an id is fuzzed without anyone remembering to add it.
// Each is called as user B twice (session cookie, then API key), the MCP tools once, and Organization A is
// compared before and after.

type Failure = string;

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await run(items[next++] as T);
		}),
	);
}

function rank(method: string) {
	// Destructive calls last, so a leak in a read is still reported when an earlier delete took the row away.
	return method === "DELETE" ? 2 : method === "GET" ? 0 : 1;
}

async function send(request: APIRequestContext, built: BuiltRequest) {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(built.query))
		for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
	const query = params.size > 0 ? `?${params}` : "";
	const url = `/api/openapi${built.url}${query}`;
	const options = { method: built.method, timeout: 20_000, failOnStatusCode: false } as const;
	if (built.multipart)
		return request.fetch(url, {
			...options,
			multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") } },
		});
	return request.fetch(url, { ...options, ...(built.json === undefined ? {} : { data: built.json }) });
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Judges one answer. Returns a failure line, or undefined when B got nothing of A's. */
function judge(
	orgs: TwoOrgs,
	label: string,
	status: number,
	text: string,
	sentIds: string[],
	allowedEmpty: boolean,
	extraStatuses: number[],
): Failure | undefined {
	const leaks = findLeaks(text, orgs.markers, orgs.foreignIds, sentIds);
	if (leaks.length > 0) return `${label}: ${status} carries Organization A's ${leaks.join(", ")}`;
	if (status === 404 || extraStatuses.includes(status)) return undefined;
	// A stream answers 200 and then reports the failure as an event.
	if (status === 200 && /^event: error\s+data: .*"code":"NOT_FOUND"/m.test(text)) return undefined;
	if (status >= 200 && status < 300 && allowedEmpty) {
		return isEmptyResult(parse(text)) ? undefined : `${label}: ${status} is not an empty result: ${text.slice(0, 200)}`;
	}
	return `${label}: expected 404, got ${status}: ${text.slice(0, 600)}`;
}

test("an id from another organization never reads, changes or links Organization A's data", async ({
	playwright,
	baseURL,
	account,
}, testInfo) => {
	test.setTimeout(170_000);
	const root = String(baseURL ?? testInfo.project.use.baseURL ?? "http://localhost:3000");
	const orgs = await createTwoOrgs(playwright, root, account);
	const failures: Failure[] = [];

	try {
		const document = (await (await orgs.anonymous.get("/api/openapi/spec.json")).json()) as OpenApiDocument;
		const operations = readOperations(document);
		expect(operations.length).toBeGreaterThan(100);

		// 1. Inventory: every operation either takes an id (and is fuzzed) or is on the commented skip list.
		const keys = new Set(operations.map((operation) => operation.key));
		for (const key of Object.keys(NO_TENANT_ID))
			if (!keys.has(key)) failures.push(`skip list names an unknown operation: ${key}`);
		const fuzzed: Operation[] = [];
		for (const operation of operations) {
			const skipped = operation.key in NO_TENANT_ID;
			if (skipped && operation.idFields.length > 0 && !ITEM_IDS_ONLY.has(operation.key))
				failures.push(`${operation.key} is on the skip list but takes ${operation.idFields.join(", ")}`);
			else if (!skipped && operation.idFields.length === 0)
				failures.push(`${operation.key} takes no id and is not on the skip list (NO_TENANT_ID)`);
			else if (!skipped) fuzzed.push(operation);
		}

		// 2. Requests, with Organization A's ids in every id field.
		const problems: string[] = [];
		type Planned = { label: string; operation: Operation; built: BuiltRequest; allowedEmpty: boolean; extra: number[] };
		const planned: Planned[] = [];
		for (const operation of fuzzed) {
			const override = OVERRIDES[operation.key];
			for (const [index, variant] of [override, ...(override?.variants ?? [])].entries()) {
				planned.push({
					label: `${operation.key}${index > 0 ? ` (variant ${index})` : ""}`,
					operation,
					built: buildRequest(document, operation, orgs.ids, variant, problems),
					allowedEmpty: true,
					extra: variant?.allow?.statuses ?? [],
				});
			}
		}
		failures.push(...problems);
		planned.sort((left, right) => rank(left.operation.method) - rank(right.operation.method));

		const publicPage = `/${orgs.aResume.username}/${orgs.aResume.slug}`;
		// MCP plans and the control call run before the snapshot of Organization A: the control uses A's own API key,
		// which updates the key's usage columns, and that must not read as a change made by B.
		// 5. MCP: the tools that take ids, with B's key and A's ids.
		const mcp = async (method: string, params: unknown) => {
			const response = await orgs.bKeyed.post("/mcp", {
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				data: { jsonrpc: "2.0", id: 1, method, params },
				failOnStatusCode: false,
				timeout: 20_000,
			});
			return { status: response.status(), text: await response.text() };
		};
		const listed = await mcp("tools/list", {});
		const tools = (parse(listed.text) as { result?: { tools?: McpTool[] } }).result?.tools ?? [];
		expect(tools.length, "MCP tools/list as B").toBeGreaterThan(20);
		const mcpPlans = tools.flatMap((tool) => {
			const built = buildMcpArguments(tool, orgs.ids, problems);
			return built ? [{ tool, ...built }] : [];
		});
		failures.push(...problems.filter((problem) => !failures.includes(problem)));
		mcpPlans.sort(
			(left, right) =>
				Number(/delete|forget|dismiss|purge|trash/.test(left.tool.name)) -
				Number(/delete|forget|dismiss|purge|trash/.test(right.tool.name)),
		);

		// P1-Q10 (Q03 review F2), control: the same kind of call as A, with A's own ids and A's key, returns A's data.
		// Without this, a tool whose arguments are merely malformed would pass step 5 as "refused" and the scanner could
		// never be shown to see a leak. The first read-only id-taking tool that answers is enough.
		const mcpAs = async (key: string, method: string, params: unknown) => {
			const response = await orgs.aKeyed.post("/mcp", {
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				data: { jsonrpc: "2.0", id: 2, method, params },
				failOnStatusCode: false,
				timeout: 20_000,
			});
			return { key, status: response.status(), text: await response.text() };
		};
		const readOnly = mcpPlans.filter(({ tool }) => /(^|_)(get|read|list)(_|$)/.test(tool.name)).slice(0, 15);
		let controlTool: string | undefined;
		for (const { tool, args } of readOnly) {
			const answer = await mcpAs(tool.name, "tools/call", { name: tool.name, arguments: args });
			const result = (parse(answer.text) as { result?: { isError?: boolean } }).result;
			if (
				answer.status === 200 &&
				result &&
				!result.isError &&
				findLeaks(answer.text, orgs.markers, orgs.foreignIds, []).length > 0
			) {
				controlTool = tool.name;
				break;
			}
		}
		expect(controlTool, "an id-taking MCP tool called as A with A's own id must return A's data").toBeDefined();

		// P2-Q01 (step 3b, run before the snapshot of Organization A because A's key usage columns change when it is verified): the same inventory on Organization B's own host (an organization host), with A's credentials and A's
		// ids. The platform-host pass above is unchanged. Host-based tenancy must refuse A everywhere on B's host: the
		// answer is the join-or-switch refusal (ORG_HOST_NOT_MEMBER) for a session and ORG_HOST_KEY_MISMATCH for A's
		// API key, and none of A's data comes back. Needs ORG_HOST_PATTERN on the e2e server (the CI job sets it).
		let hostRefusals = 0;
		let hostRequests = 0;
		if (orgHostsConfigured()) {
			const port = new URL(root).port || "80";
			const slugs = await withSeedPool(async (pool) => {
				const { rows } = await pool.query<{ id: string; slug: string }>(
					"select id, slug from organization where id = any($1::text[])",
					[[orgs.a.organizationId, orgs.b.organizationId]],
				);
				return Object.fromEntries(rows.map((row) => [row.id, row.slug]));
			});
			const hostOf = (organizationId: string) => `${slugs[organizationId]}.orgs.test:${port}`;
			const bHost = hostOf(orgs.b.organizationId);
			const aHost = hostOf(orgs.a.organizationId);
			expect(slugs[orgs.a.organizationId], "Organization A's slug").toBeTruthy();
			expect(slugs[orgs.b.organizationId], "Organization B's slug").toBeTruthy();
			const aCookie = (await orgs.a.session.storageState()).cookies
				.filter((cookie) => cookie.name.includes("session_token"))
				.map((cookie) => `${cookie.name}=${cookie.value}`)
				.join("; ");
			expect(aCookie, "A's session cookie").not.toBe("");
			const hostContext = (host: string, headers: Record<string, string>) =>
				playwright.request.newContext({
					baseURL: root,
					extraHTTPHeaders: { host, origin: `http://${host}`, ...headers },
				});

			// Control: A's credentials on A's own host return A's data, so the scanner can see it in such an answer.
			const home = await hostContext(aHost, { cookie: aCookie });
			const homeAnswer = await home.get(`/api/openapi/resumes/${orgs.ids.resume}`, { failOnStatusCode: false });
			expect(homeAnswer.status(), "A's own resume on A's host").toBe(200);
			expect(findLeaks(await homeAnswer.text(), orgs.markers, orgs.foreignIds, [])).not.toEqual([]);
			await home.dispose();

			// A's own API key is an account-level credential, not tenant data (phase plan D8): its owner may delete it from any
			// host, which would end the API-key mode below. That route is left out of this pass (docs/questions.md Q153).
			const hostPlanned = planned.filter((plan) => plan.operation.key !== "DELETE /auth/api-keys/{keyId}");
			for (const [mode, headers, refusal] of [
				["org host cookie", { cookie: aCookie }, "ORG_HOST_NOT_MEMBER"],
				["org host api key", { "x-api-key": orgs.aApiKey }, "ORG_HOST_KEY_MISMATCH"],
			] as const) {
				const request = await hostContext(bHost, headers);
				try {
					await pool(hostPlanned, 6, async (plan) => {
						const label = `${plan.label} [${mode}]`;
						try {
							const response = await send(request, plan.built);
							const text = await response.text();
							hostRequests += 1;
							const leaks = findLeaks(text, orgs.markers, orgs.foreignIds, plan.built.sentIds);
							if (leaks.length > 0)
								return void failures.push(
									`${label}: ${response.status()} carries Organization A's ${leaks.join(", ")}`,
								);
							if (response.status() === 403 && text.includes(refusal)) return void (hostRefusals += 1);
							// Anything else must be a refusal too: never a success that returns or changes data.
							if (response.status() >= 200 && response.status() < 300 && !plan.allowedEmpty)
								failures.push(`${label}: succeeded on B's host with A's credentials (${response.status()})`);
							else if (response.status() >= 200 && response.status() < 300 && !isEmptyResult(parse(text)))
								failures.push(
									`${label}: ${response.status()} is not an empty result on B's host: ${text.slice(0, 200)}`,
								);
						} catch (error) {
							failures.push(`${label}: request failed: ${(error as Error).message.slice(0, 200)}`);
						}
					});
				} finally {
					await request.dispose();
				}
			}
			// The pass must have reached the host gate, not been turned away earlier for being malformed.
			expect(hostRefusals, "requests refused by the organization host gate").toBeGreaterThan(hostPlanned.length);
		} else {
			// Not a silent pass: the CI e2e job always sets the pattern, so this only happens on a local run without it.
			console.log(`cross-org fuzz: org-host pass NOT RUN, the e2e server needs ORG_HOST_PATTERN=${ORG_HOST_PATTERN}`);
		}

		const before = await snapshotOrgA(orgs);
		const publicBefore = await orgs.anonymous.get(publicPage);
		expect(publicBefore.status(), "Organization A's public resume page without a session").toBe(200);

		// Control: the same read requests succeed as A, and the scanner sees A's values in them. Without this, a request
		// that is merely malformed would pass as "not found".
		const reads = planned.filter(
			(plan) => plan.operation.method === "GET" && !plan.operation.path.endsWith("/updates"),
		);
		let carried = 0;
		await pool(reads, 6, async (plan) => {
			const response = await send(orgs.a.session, plan.built);
			const text = await response.text();
			if (response.status() >= 400 && !plan.extra.includes(response.status()))
				failures.push(`control ${plan.label}: user A's own call answered ${response.status()}: ${text.slice(0, 200)}`);
			if (findLeaks(text, orgs.markers, orgs.foreignIds, []).length > 0) carried += 1;
		});
		expect(carried, "the scanner must see Organization A's values in A's own answers").toBeGreaterThan(10);

		// 3. B calls everything with A's ids: session cookie first, then API key.
		const seen = new Map<string, string>();
		for (const [mode, request] of [
			["cookie", orgs.b.session],
			["api key", orgs.bKeyed],
		] as const) {
			await pool(planned, 6, async (plan) => {
				const label = `${plan.label} [${mode}]`;
				try {
					const response = await send(request, plan.built);
					const text = await response.text();
					seen.set(label, `${response.status()}`);
					const failure = judge(
						orgs,
						label,
						response.status(),
						text,
						plan.built.sentIds,
						plan.allowedEmpty,
						plan.extra,
					);
					if (failure) failures.push(failure);
				} catch (error) {
					failures.push(`${label}: request failed: ${(error as Error).message.slice(0, 200)}`);
				}
			});
		}

		// 4. The list routes that take no id are where a leak would show up as extra rows.
		const sweep = operations.filter((operation) => operation.method === "GET" && operation.key in NO_TENANT_ID);
		for (const [mode, request] of [
			["cookie", orgs.b.session],
			["api key", orgs.bKeyed],
		] as const) {
			await pool(sweep, 6, async (operation) => {
				if (
					operation.pathParams.length > 0 ||
					operation.path.startsWith("/api/") ||
					operation.path === "/auth/account/export"
				)
					return;
				const response = await request.get(`/api/openapi${operation.path}`, {
					failOnStatusCode: false,
					timeout: 20_000,
				});
				const text = await response.text();
				const leaks = findLeaks(text, orgs.markers, orgs.foreignIds, []);
				if (leaks.length > 0)
					failures.push(
						`${operation.key} [${mode}]: ${response.status()} carries Organization A's ${leaks.join(", ")}`,
					);
			});
		}

		await pool(mcpPlans, 6, async ({ tool, args, sentIds }) => {
			const label = `MCP ${tool.name}`;
			const answer = await mcp("tools/call", { name: tool.name, arguments: args });
			const leaks = findLeaks(answer.text, orgs.markers, orgs.foreignIds, sentIds);
			if (leaks.length > 0) return void failures.push(`${label}: carries Organization A's ${leaks.join(", ")}`);
			const result = (parse(answer.text) as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
			if (answer.status !== 200 || !result)
				return void failures.push(`${label}: HTTP ${answer.status}: ${answer.text.slice(0, 200)}`);
			if (result.isError) return;
			const body = parse(result.content?.map((part) => part.text ?? "").join("") ?? "");
			if (!(tool.name in MCP_ALLOW) && !isEmptyResult(body))
				failures.push(`${label}: succeeded for A's ids: ${JSON.stringify(body).slice(0, 200)}`);
		});

		// 6. Public routes still work without a session, and B cannot list them.
		const publicAfter = await orgs.anonymous.get(publicPage);
		expect(publicAfter.status(), "Organization A's public resume page after the run").toBe(200);
		const publicData = await orgs.anonymous.get(`/api/openapi/resumes/${orgs.aResume.username}/${orgs.aResume.slug}`);
		expect(publicData.status(), "Organization A's public resume through the API").toBe(200);
		for (const path of ["/resumes", "/documents", "/documents/page?limit=100"]) {
			const listing = await orgs.b.session.get(`/api/openapi${path}`);
			const leaks = findLeaks(await listing.text(), orgs.markers, orgs.foreignIds, []);
			if (leaks.length > 0) failures.push(`B's ${path} lists Organization A's ${leaks.join(", ")}`);
		}

		// 7. Organization A is unchanged.
		const after = await snapshotOrgA(orgs);
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
			if (before[key] !== after[key]) failures.push(`Organization A changed: ${key}`);

		console.log(
			`cross-org fuzz: ${fuzzed.length} id-taking operations, ${planned.length} requests per mode, ${mcpPlans.length} MCP tools, ${Object.keys(NO_TENANT_ID).length} skipped; org-host pass: ${hostRequests} requests, ${hostRefusals} refused by the host gate`,
		);
		expect(failures, failures.join("\n")).toEqual([]);
	} finally {
		await orgs.dispose();
	}
});
