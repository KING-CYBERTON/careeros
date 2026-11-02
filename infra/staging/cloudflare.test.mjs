// CAREEROS: P2-C01. Self-test for cloudflare.mjs with a stubbed fetch and an in-memory Cloudflare. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { main, MANAGED_COMMENT } from "./cloudflare.mjs";

const INFRA = "test-infra-token-PLACEHOLDER-1111";
const SAAS = "test-saas-token-PLACEHOLDER-2222";
const ENV = {
	CF_STAGING_INFRA_TOKEN: INFRA,
	CF_SAAS_API_TOKEN: SAAS,
	CF_ACCOUNT_ID: "acct-placeholder",
	CF_ZONE_ID: "zone-placeholder",
	CF_TUNNEL_ID: "tunnel-placeholder",
	STAGING_HOST: "careeros-staging.example.test",
	CF_SAAS_CNAME_TARGET: "careeros-saas-origin.example.test",
	ORG_HOST_PATTERN: "{slug}-careeros.example.test",
};

/** A tiny in-memory Cloudflare. `calls` records every request; `failWith` makes every request an API error. */
function fakeCloudflare({ records = [], ingress = [], fallback = null, failWith = null } = {}) {
	const state = { records: [...records], ingress, fallback, calls: [], nextId: 1 };
	const reply = (result, status = 200) =>
		new Response(JSON.stringify({ success: true, errors: [], result }), { status });
	state.fetch = async (url, init) => {
		const u = new URL(url);
		const method = init.method;
		const path = u.pathname.replace("/client/v4", "");
		state.calls.push({ method, path, auth: init.headers.authorization });
		if (failWith) {
			return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: failWith }] }), {
				status: 403,
			});
		}
		const body = init.body ? JSON.parse(init.body) : undefined;
		if (path.endsWith("/configurations")) {
			if (method === "GET") return reply({ config: { ingress: state.ingress } });
			state.ingress = body.config.ingress;
			return reply({});
		}
		if (path.endsWith("/custom_hostnames/fallback_origin")) {
			if (method === "GET") {
				return state.fallback
					? reply(state.fallback)
					: new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "none" }] }), { status: 404 });
			}
			state.fallback = { origin: body.origin, status: "active" };
			return reply(state.fallback);
		}
		if (path.endsWith("/dns_records") && method === "GET") {
			const name = u.searchParams.get("name");
			const comment = u.searchParams.get("comment.exact");
			return reply(state.records.filter((r) => (!name || r.name === name) && (!comment || r.comment === comment)));
		}
		if (path.endsWith("/dns_records") && method === "POST") {
			state.records.push({ id: `r${state.nextId++}`, ...body });
			return reply(body);
		}
		const m = path.match(/\/dns_records\/(.+)$/);
		if (m && method === "PATCH") {
			state.records = state.records.map((r) => (r.id === m[1] ? { ...r, ...body } : r));
			return reply({});
		}
		if (m && method === "DELETE") {
			state.records = state.records.filter((r) => r.id !== m[1]);
			return reply({});
		}
		throw new Error(`unexpected request ${method} ${path}`);
	};
	return state;
}

async function run(args, state, env = ENV) {
	let out = "";
	let err = "";
	const code = await main(args, env, {
		fetch: state.fetch,
		stdout: (t) => (out += t),
		stderr: (t) => (err += t),
	});
	return { code, out, err };
}

const writes = (state) => state.calls.filter((c) => c.method !== "GET");
const managed = (name, extra = {}) => ({
	id: "rx",
	type: "CNAME",
	name,
	content: "tunnel-placeholder.cfargotunnel.com",
	proxied: true,
	comment: MANAGED_COMMENT,
	...extra,
});

test("a dry run makes no write calls", async () => {
	for (const args of [["tunnel-ingress"], ["fallback-origin"], ["org-dns", "acme"]]) {
		const state = fakeCloudflare();
		const { code, out } = await run(args, state);
		assert.equal(code, 0);
		assert.match(out, /PLAN:/);
		assert.equal(writes(state).length, 0, `${args[0]} wrote in a dry run`);
	}
	const state = fakeCloudflare({ records: [managed("acme-careeros.example.test")] });
	const { code, out } = await run(["org-dns-remove", "acme"], state);
	assert.equal(code, 0);
	assert.match(out, /PLAN: DELETE/);
	assert.equal(writes(state).length, 0);
});

test("a missing setting fails by name and makes no API call", async () => {
	const state = fakeCloudflare();
	const { code, err } = await run(["tunnel-ingress"], state, { ...ENV, CF_STAGING_INFRA_TOKEN: "" });
	assert.equal(code, 1);
	assert.match(err, /Missing setting: CF_STAGING_INFRA_TOKEN/);
	assert.equal(state.calls.length, 0);
});

test("tokens never appear in stdout or stderr, including on an API error", async () => {
	const ok = fakeCloudflare();
	const a = await run(["tunnel-ingress"], ok);
	const b = await run(["status"], ok);
	// An API error whose message echoes the token must still be scrubbed.
	const bad = fakeCloudflare({ failWith: `bad credentials ${INFRA} ${SAAS}` });
	const c = await run(["tunnel-ingress", "--apply"], bad);
	assert.equal(c.code, 1);
	assert.match(c.err, /10000/);
	for (const r of [a, b, c]) {
		for (const secret of [INFRA, SAAS]) {
			assert.ok(!r.out.includes(secret) && !r.err.includes(secret), "a token was printed");
		}
	}
	assert.ok(bad.calls.every((call) => call.auth === `Bearer ${INFRA}`));
});

test("fallback-origin refuses a name that matches the pattern", async () => {
	const state = fakeCloudflare();
	const { code, err } = await run(["fallback-origin", "--apply"], state, {
		...ENV,
		ORG_HOST_PATTERN: "{slug}.example.test",
	});
	assert.equal(code, 1);
	assert.match(err, /matches ORG_HOST_PATTERN/);
	assert.equal(writes(state).length, 0);
});

test("org-dns rejects an invalid slug and a label over 63 characters", async () => {
	for (const slug of ["Acme", "a.b", "a_b", "", "x".repeat(64), "x".repeat(60), "-a", "a-", "-"]) {
		const state = fakeCloudflare();
		const { code, err } = await run(["org-dns", slug, "--apply"], state);
		assert.equal(code, 1, `slug "${slug}"`);
		assert.ok(err.length > 0);
		assert.equal(writes(state).length, 0);
	}
	const state = fakeCloudflare();
	assert.equal((await run(["org-dns", "x".repeat(52), "--apply"], state)).code, 0);
});

test("org-dns-remove refuses an unmanaged record and a name outside the pattern", async () => {
	const name = "acme-careeros.example.test";
	const unmanaged = fakeCloudflare({ records: [managed(name, { comment: "mine" })] });
	const a = await run(["org-dns-remove", "acme", "--apply"], unmanaged);
	assert.equal(a.code, 1);
	assert.match(a.err, /not tagged/);
	assert.equal(writes(unmanaged).length, 0);

	// A record with the managed comment whose name is outside the pattern (it is never matched or deleted).
	const outside = fakeCloudflare({ records: [managed("other.example.test")] });
	const realFetch = outside.fetch;
	outside.fetch = async (url, init) => {
		const res = await realFetch(url, init);
		if (init.method !== "GET" || !new URL(url).pathname.endsWith("/dns_records")) return res;
		return new Response(JSON.stringify({ success: true, errors: [], result: [managed("other.example.test")] }), {
			status: 200,
		});
	};
	const b = await run(["org-dns-remove", "acme", "--apply"], outside);
	assert.equal(b.code, 0);
	assert.match(b.out, /nothing to remove/);
	assert.equal(writes(outside).length, 0);

	assert.equal((await run(["org-dns-remove", "bad slug", "--apply"], fakeCloudflare())).code, 1);
});

test("a second --apply of each command makes no write calls", async () => {
	const state = fakeCloudflare();
	for (const args of [["tunnel-ingress"], ["fallback-origin"], ["org-dns", "acme"]]) {
		assert.equal((await run([...args, "--apply"], state)).code, 0);
		state.calls.length = 0;
		assert.equal((await run([...args, "--apply"], state)).code, 0);
		assert.equal(writes(state).length, 0, `${args[0]} wrote on the second run`);
	}
	assert.equal(state.ingress.length, 2);
	assert.equal(state.ingress[1].hostname, undefined);
	assert.equal(state.fallback.origin, "careeros-saas-origin.example.test");
	assert.equal((await run(["org-dns-remove", "acme", "--apply"], state)).code, 0);
	state.calls.length = 0;
	assert.equal((await run(["org-dns-remove", "acme", "--apply"], state)).code, 0);
	assert.equal(writes(state).length, 0);
});

test("status is read only and lists managed records", async () => {
	const state = fakeCloudflare({ records: [managed("acme-careeros.example.test")] });
	const { code, out } = await run(["status"], state);
	assert.equal(code, 0);
	assert.match(out, /acme-careeros\.example\.test/);
	assert.equal(writes(state).length, 0);
});
