import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudflareError, createCloudflareClient } from "./cloudflare";
import { FakeCloudflare } from "./fake-cloudflare";

// P2-T06: the Cloudflare client against an injected fetch. No network.
const TOKEN = "cf-secret-token-value-do-not-log";
const ZONE = "0123456789abcdef0123456789abcdef";

const captured: string[] = [];
function captureConsole() {
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			captured.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
		});
}

afterEach(() => {
	vi.restoreAllMocks();
	captured.length = 0;
});

const client = (fake: FakeCloudflare, extra: Partial<Parameters<typeof createCloudflareClient>[0]> = {}) =>
	createCloudflareClient({ token: TOKEN, zoneId: ZONE, fetch: fake.fetch, sleep: async () => undefined, ...extra });

describe("Cloudflare client", () => {
	it("creates a custom hostname with HTTP validation and a DV certificate, with the token only in Authorization", async () => {
		const fake = new FakeCloudflare();
		const created = await client(fake).create("careers.acme.test");
		expect(created).toMatchObject({
			hostname: "careers.acme.test",
			status: "pending",
			sslStatus: "pending_validation",
		});
		const [request] = fake.requests;
		expect(request).toMatchObject({
			method: "POST",
			url: `/client/v4/zones/${ZONE}/custom_hostnames`,
			authorization: `Bearer ${TOKEN}`,
			body: { hostname: "careers.acme.test", ssl: { method: "http", type: "dv" } },
		});
		expect(JSON.stringify(request?.body)).not.toContain(TOKEN);
		expect(request?.url).not.toContain(TOKEN);
	});

	it("gets, finds by exact name and deletes; an already deleted hostname counts as deleted", async () => {
		const fake = new FakeCloudflare();
		const cf = client(fake);
		const created = await cf.create("a.acme.test");
		await cf.create("b.acme.test");
		await expect(cf.get(created.id)).resolves.toMatchObject({ id: created.id, hostname: "a.acme.test" });
		await expect(cf.find("b.acme.test")).resolves.toMatchObject({ hostname: "b.acme.test" });
		await expect(cf.find("c.acme.test")).resolves.toBeNull();
		await cf.delete(created.id);
		expect(fake.hosts.has(created.id)).toBe(false);
		await expect(cf.delete(created.id)).resolves.toBeUndefined();
		await expect(cf.get(created.id)).rejects.toMatchObject({ status: 404, isNotFound: true });
	});

	it("reports the duplicate error (1406) so the caller can adopt the existing hostname", async () => {
		const fake = new FakeCloudflare();
		const cf = client(fake);
		await cf.create("dup.acme.test");
		await expect(cf.create("dup.acme.test")).rejects.toMatchObject({ isDuplicate: true, status: 409, codes: [1406] });
	});

	it("retries an idempotent GET on a transient failure, up to three attempts", async () => {
		const fake = new FakeCloudflare();
		const cf = client(fake);
		const created = await cf.create("retry.acme.test");
		fake.requests.length = 0;
		fake.failures.push({ match: (r) => r.method === "GET", status: 503, times: 2 });
		await expect(cf.get(created.id)).resolves.toMatchObject({ id: created.id });
		expect(fake.calls("GET")).toHaveLength(3);

		fake.requests.length = 0;
		fake.failures.push({ match: (r) => r.method === "GET", status: 500, times: 5 });
		captureConsole();
		await expect(cf.get(created.id)).rejects.toMatchObject({ status: 500 });
		expect(fake.calls("GET")).toHaveLength(3);
	});

	it("does not retry a client error, a create or a delete", async () => {
		const fake = new FakeCloudflare();
		const cf = client(fake);
		captureConsole();
		fake.failures.push({ match: (r) => r.method === "GET", status: 403, codes: [10000], times: 5 });
		await expect(cf.get("x")).rejects.toMatchObject({ status: 403, codes: [10000] });
		expect(fake.calls("GET")).toHaveLength(1);
		fake.failures.length = 0;

		fake.failures.push({ match: (r) => r.method === "POST", status: 502, times: 5 });
		await expect(cf.create("a.acme.test")).rejects.toBeInstanceOf(CloudflareError);
		expect(fake.calls("POST")).toHaveLength(1);
		fake.failures.length = 0;

		fake.failures.push({ match: (r) => r.method === "DELETE", status: 500, times: 5 });
		await expect(cf.delete("x")).rejects.toMatchObject({ status: 500 });
		expect(fake.calls("DELETE")).toHaveLength(1);
	});

	it("times out after the configured time and reports it without a status", async () => {
		const hang: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		captureConsole();
		const cf = createCloudflareClient({
			token: TOKEN,
			zoneId: ZONE,
			fetch: hang,
			timeoutMs: 20,
			sleep: async () => undefined,
		});
		await expect(cf.create("slow.acme.test")).rejects.toMatchObject({ failure: "timeout", status: null });
	});

	it("uses a 10-second timeout by default", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const fake = new FakeCloudflare();
		await createCloudflareClient({ token: TOKEN, zoneId: ZONE, fetch: fake.fetch }).create("t.acme.test");
		expect(spy).toHaveBeenCalledWith(10_000);
	});

	it("rejects a response without a usable result", async () => {
		captureConsole();
		const odd: typeof fetch = async () =>
			new Response(JSON.stringify({ success: true, result: { nope: 1 } }), { status: 200 });
		await expect(createCloudflareClient({ token: TOKEN, zoneId: ZONE, fetch: odd }).get("x")).rejects.toMatchObject({
			failure: "response",
		});
	});

	it("never logs the token or a response body: status and error codes only", async () => {
		const fake = new FakeCloudflare();
		const cf = client(fake);
		captureConsole();
		fake.failures.push({
			match: () => true,
			status: 401,
			codes: [10000],
			echo: `Bearer ${TOKEN} is invalid`,
			times: 5,
		});
		const error = await cf.create("secret.acme.test").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CloudflareError);
		expect((error as Error).message).not.toContain(TOKEN);
		expect(captured.join("\n")).toContain("HTTP 401");
		expect(captured.join("\n")).toContain("10000");
		expect(captured.join("\n")).not.toContain(TOKEN);
		expect(captured.join("\n")).not.toContain("invalid");
		expect(JSON.stringify(error)).not.toContain(TOKEN);
	});
});
