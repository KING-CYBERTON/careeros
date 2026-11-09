import { describe, expect, it, vi } from "vite-plus/test";
import { createPaystackClient, PaystackError } from "./paystack-client";

// CAREEROS (P3-T05): the HTTP client against a mocked fetch. No network.
const SECRET = "sk_test_client_test_secret_0000";

const reply = (status: number, body: unknown) =>
	vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(body), { status }));

describe("paystack client", () => {
	it("sends the key as a bearer token, the body as JSON and returns `data`", async () => {
		const fetchMock = reply(200, { status: true, message: "ok", data: { authorization_url: "https://x" } });
		const client = createPaystackClient({ secretKey: SECRET, fetch: fetchMock });
		await expect(client.post("/transaction/initialize", { amount: 100 })).resolves.toEqual({
			authorization_url: "https://x",
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.paystack.co/transaction/initialize");
		expect(init?.method).toBe("POST");
		expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
		expect(init?.body).toBe('{"amount":100}');
		expect(init?.redirect).toBe("error");
	});

	it("GET sends no body", async () => {
		const fetchMock = reply(200, { status: true, data: { id: 1 } });
		await createPaystackClient({ secretKey: SECRET, fetch: fetchMock }).get("/transaction/verify/abc");
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
		expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
	});

	it("maps a refusal to a readable message that carries Paystack's own words only", async () => {
		const client = createPaystackClient({
			secretKey: SECRET,
			fetch: reply(400, { status: false, message: "Invalid Amount Sent", data: { card: "4081" } }),
		});
		const error = await client.post("/x", {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PaystackError);
		expect((error as PaystackError).message).toBe("Paystack refused the request: Invalid Amount Sent");
		expect((error as PaystackError).status).toBe(400);
		expect((error as PaystackError).retryable).toBe(false);
		expect(JSON.stringify(error)).not.toContain("4081");
	});

	it("never puts the key or the request into an error", async () => {
		const failing = vi.fn(async () => {
			throw new Error(`connect ECONNREFUSED https://api.paystack.co Bearer ${SECRET}`);
		});
		const error = (await createPaystackClient({ secretKey: SECRET, fetch: failing as never })
			.get("/x")
			.catch((e: unknown) => e)) as PaystackError;
		expect(error.message).toBe("Paystack could not be reached.");
		expect(error.status).toBeNull();
		expect(error.retryable).toBe(true);
		expect(error.message).not.toContain(SECRET);
	});

	it("times out with a fixed sentence and does not retry", async () => {
		const hanging = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				}),
		);
		const client = createPaystackClient({ secretKey: SECRET, fetch: hanging as never, timeoutMs: 20 });
		await expect(client.post("/x", {})).rejects.toThrow("Paystack did not answer in time.");
		expect(hanging).toHaveBeenCalledTimes(1);
	});

	it("does not retry a failed POST", async () => {
		const fetchMock = reply(500, { status: false, message: "boom" });
		const client = createPaystackClient({ secretKey: SECRET, fetch: fetchMock });
		await expect(client.post("/x", {})).rejects.toMatchObject({ status: 500, retryable: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats a 200 whose status is false, and an unreadable body, as failures", async () => {
		await expect(
			createPaystackClient({ secretKey: SECRET, fetch: reply(200, { status: false, message: "no" }) }).get("/x"),
		).rejects.toBeInstanceOf(PaystackError);
		const garbage = vi.fn(async () => new Response("<html>", { status: 502 }));
		await expect(createPaystackClient({ secretKey: SECRET, fetch: garbage as never }).get("/x")).rejects.toMatchObject({
			status: 502,
		});
	});

	it("keeps a control character and a very long message out of the text", async () => {
		const client = createPaystackClient({
			secretKey: SECRET,
			fetch: reply(400, { status: false, message: `bad\n\tthing${"x".repeat(500)}` }),
		});
		const error = (await client.get("/x").catch((e: unknown) => e)) as PaystackError;
		expect(error.message).not.toMatch(/[\n\t]/);
		expect(error.message.length).toBeLessThan(260);
	});
});
