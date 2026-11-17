import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// P6-T02: provider selection, the Plunk path of sendEmail and sendCareerNotification, and the suppression skip. Plunk's
// HTTP API is a mocked fetch and the suppression list a mocked module: no network, no database.

const envMock = vi.hoisted(() => ({
	EMAIL_PROVIDER: undefined as "plunk" | "smtp" | "log" | undefined,
	SMTP_HOST: undefined as string | undefined,
	SMTP_PORT: 587,
	SMTP_USER: undefined as string | undefined,
	SMTP_PASS: undefined as string | undefined,
	SMTP_FROM: undefined as string | undefined,
	SMTP_SECURE: false,
	PLUNK_SECRET_KEY: undefined as string | undefined,
	PLUNK_API_URL: "https://plunk.example.test",
	EMAIL_FROM_ADDRESS: undefined as string | undefined,
	APP_URL: "https://careers.example.com",
}));
const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
const isEmailSuppressed = vi.hoisted(() => vi.fn<(address: string) => Promise<boolean>>());

vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));
vi.mock("react-email", () => ({
	render: async (_node: unknown, opts?: { plainText?: boolean }) =>
		opts?.plainText ? "plain text body" : "<p>html body</p>",
}));
vi.mock("./suppression", () => ({ isEmailSuppressed }));

const { deliverEmail, resolveEmailProvider, sendCareerNotification, sendEmail } = await import("./transport");

const fakeReact = { $$typeof: Symbol.for("react.element") } as unknown as React.ReactElement;
const fetchMock = vi.fn<typeof fetch>();

const smtp = () => {
	envMock.SMTP_HOST = "smtp.example.com";
	envMock.SMTP_USER = "user";
	envMock.SMTP_PASS = "pass";
	envMock.SMTP_FROM = "noreply@example.com";
};
const plunk = () => {
	envMock.EMAIL_PROVIDER = "plunk";
	envMock.PLUNK_SECRET_KEY = "sk_unit_test_key";
	envMock.EMAIL_FROM_ADDRESS = "no-reply@example.test";
};

beforeEach(() => {
	envMock.EMAIL_PROVIDER = undefined;
	envMock.SMTP_HOST = envMock.SMTP_USER = envMock.SMTP_PASS = envMock.SMTP_FROM = undefined;
	envMock.PLUNK_SECRET_KEY = envMock.EMAIL_FROM_ADDRESS = undefined;
	sendMail.mockClear();
	createTransport.mockClear();
	isEmailSuppressed.mockReset().mockResolvedValue(false);
	fetchMock.mockReset().mockImplementation(async () => Response.json({ data: { emails: [{ email: "email_1" }] } }));
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const body = () =>
	JSON.parse(((fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit).body as string) as Record<string, unknown>;

describe("provider selection", () => {
	it("is smtp when the SMTP variables are complete and nothing is chosen (unchanged upstream behaviour)", () => {
		smtp();
		expect(resolveEmailProvider()).toBe("smtp");
	});

	it("is log when nothing is configured", () => {
		expect(resolveEmailProvider()).toBe("log");
	});

	it("is log when the SMTP variables are incomplete", () => {
		smtp();
		envMock.SMTP_PASS = undefined;
		expect(resolveEmailProvider()).toBe("log");
	});

	it("follows EMAIL_PROVIDER when it is set", () => {
		smtp();
		envMock.EMAIL_PROVIDER = "log";
		expect(resolveEmailProvider()).toBe("log");
		plunk();
		expect(resolveEmailProvider()).toBe("plunk");
	});

	it("falls back to log rather than send through a half-configured plunk", () => {
		envMock.EMAIL_PROVIDER = "plunk";
		expect(resolveEmailProvider()).toBe("log");
	});

	it("does not use SMTP when log is chosen, even with complete SMTP settings", async () => {
		smtp();
		envMock.EMAIL_PROVIDER = "log";
		await sendEmail({ to: "a@b.com", subject: "hi", react: fakeReact });
		expect(createTransport).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not call Plunk when smtp is the provider", async () => {
		smtp();
		await sendEmail({ to: "a@b.com", subject: "hi", react: fakeReact });
		expect(sendMail).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(isEmailSuppressed).not.toHaveBeenCalled();
	});
});

describe("sendEmail through plunk", () => {
	it("renders the HTML and sends the organization's name and reply-to", async () => {
		plunk();
		const result = await deliverEmail({
			to: "a@b.com",
			subject: "Verify\r\nBcc: x@y.z",
			react: fakeReact,
			fromName: "Acme Careers",
			replyTo: "help@acme.example",
		});
		expect(result).toEqual({ provider: "plunk", outcome: "queued", emailId: "email_1" });
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://plunk.example.test/v1/send");
		expect(body()).toEqual({
			to: "a@b.com",
			subject: "Verify Bcc: x@y.z",
			body: "<p>html body</p>",
			from: { name: "Acme Careers", email: "no-reply@example.test" },
			reply: "help@acme.example",
			subscribed: false,
		});
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("skips a suppressed recipient and logs no address", async () => {
		plunk();
		isEmailSuppressed.mockResolvedValue(true);
		const result = await deliverEmail({ to: "gone@example.com", subject: "Secret subject", react: fakeReact });
		expect(result).toEqual({ provider: "plunk", outcome: "suppressed" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(isEmailSuppressed).toHaveBeenCalledWith("gone@example.com");
		const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]);
		expect(logged).toContain("suppressed");
		expect(logged).not.toContain("gone@example.com");
		expect(logged).not.toContain("Secret subject");
	});

	it("still sends when the suppression list cannot be read, and says so without the address", async () => {
		plunk();
		isEmailSuppressed.mockRejectedValue(new Error("connection refused for a@b.com"));
		await expect(deliverEmail({ to: "a@b.com", subject: "hi", react: fakeReact })).resolves.toMatchObject({
			outcome: "queued",
		});
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("a@b.com");
	});

	it("returns the failure and logs status, code and request id only", async () => {
		plunk();
		fetchMock.mockResolvedValue(
			Response.json(
				{ error: { code: "PLAN_LIMIT", message: "a@b.com secret body", requestId: "req_9" } },
				{ status: 402 },
			),
		);
		const result = await deliverEmail({ to: "a@b.com", subject: "hi", react: fakeReact });
		expect(result).toEqual({ provider: "plunk", outcome: "failed", code: "PLAN_LIMIT", status: 402 });
		const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
		expect(logged).toContain("req_9");
		expect(logged).toContain("402");
		for (const secret of ["sk_unit_test_key", "a@b.com", "html body", "secret body"])
			expect(logged).not.toContain(secret);
	});

	it("sendEmail resolves with nothing even when Plunk refuses", async () => {
		plunk();
		fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
		await expect(sendEmail({ to: "a@b.com", subject: "hi", react: fakeReact })).resolves.toBeUndefined();
	});
});

describe("sendCareerNotification through plunk", () => {
	const options = {
		to: "owner@example.com",
		subject: "Update",
		text: "You have <b>an update</b> in Acme.",
		url: "/career",
		key: "notification-key-1",
		fromName: "Acme",
		replyTo: "help@acme.example",
	};

	it("sends escaped HTML with the link, keyed by the notification", async () => {
		plunk();
		await expect(sendCareerNotification(options)).resolves.toBe(true);
		const sent = body();
		expect(sent).toMatchObject({
			to: "owner@example.com",
			subject: "Update",
			from: { name: "Acme", email: "no-reply@example.test" },
			reply: "help@acme.example",
			subscribed: false,
		});
		expect(sent.body).toBe(
			'<p>You have &lt;b&gt;an update&lt;/b&gt; in Acme.</p><p><a href="https://careers.example.com/career">https://careers.example.com/career</a></p>',
		);
		const key = new Headers(((fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit).headers).get("idempotency-key");
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		await sendCareerNotification(options);
		expect(new Headers(((fetchMock.mock.calls[1]?.[1] ?? {}) as RequestInit).headers).get("idempotency-key")).toBe(key);
	});

	it("counts an already used key (409) as delivered", async () => {
		plunk();
		fetchMock.mockResolvedValue(new Response("{}", { status: 409 }));
		await expect(sendCareerNotification(options)).resolves.toBe(true);
	});

	it("reports a suppressed address as not delivered", async () => {
		plunk();
		isEmailSuppressed.mockResolvedValue(true);
		await expect(sendCareerNotification(options)).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws a message without the address or the key when Plunk refuses", async () => {
		plunk();
		fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
		const error = await sendCareerNotification(options).catch((caught: unknown) => caught as Error);
		expect(error).toEqual(new Error("Career notification email could not be delivered."));
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("owner@example.com");
	});

	it("returns false when nothing is configured, and refuses a link away from the application", async () => {
		await expect(sendCareerNotification(options)).resolves.toBe(false);
		plunk();
		await expect(sendCareerNotification({ ...options, url: "https://evil.example/" })).rejects.toThrow(
			/this application/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
