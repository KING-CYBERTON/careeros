import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const envMock = vi.hoisted(() => ({
	SMTP_HOST: undefined as string | undefined,
	SMTP_PORT: 587,
	SMTP_USER: undefined as string | undefined,
	SMTP_PASS: undefined as string | undefined,
	SMTP_FROM: undefined as string | undefined,
	SMTP_SECURE: false,
	APP_URL: "https://careers.example.com",
}));

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));

vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
vi.mock("nodemailer", () => ({
	default: { createTransport },
	createTransport,
}));
vi.mock("react-email", () => ({
	render: async (_node: unknown, opts?: { plainText?: boolean }) =>
		opts?.plainText ? "plain text body" : "<p>html body</p>",
}));

const { cleanDisplayName, safeReplyTo, sendCareerNotification, sendEmail, withDisplayName } =
	await import("./transport");

const fakeReact = { $$typeof: Symbol.for("react.element") } as unknown as React.ReactElement;

const resetEnv = () => {
	envMock.SMTP_HOST = undefined;
	envMock.SMTP_USER = undefined;
	envMock.SMTP_PASS = undefined;
	envMock.SMTP_FROM = undefined;
	createTransport.mockClear();
	sendMail.mockClear();
};
describe("sendEmail", () => {
	const originalNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
	});

	it("skips email send and logs without body in production when SMTP is not configured", async () => {
		resetEnv();
		process.env.NODE_ENV = "production";
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		await expect(
			sendEmail({ to: "user@example.com", subject: "Reset password", react: fakeReact }),
		).resolves.toBeUndefined();
		expect(infoSpy).toHaveBeenCalledWith("SMTP not configured; skipping email send.", {
			to: "user@example.com",
			subject: "Reset password",
		});
		infoSpy.mockRestore();
	});

	it("skips email send and logs with body in development when SMTP is not configured", async () => {
		resetEnv();
		process.env.NODE_ENV = "development";
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		await expect(
			sendEmail({ to: "user@example.com", subject: "Reset password", react: fakeReact }),
		).resolves.toBeUndefined();
		expect(infoSpy).toHaveBeenCalledWith("SMTP not configured; skipping email send.", {
			to: "user@example.com",
			subject: "Reset password",
			text: "plain text body",
			html: "<p>html body</p>",
		});
		infoSpy.mockRestore();
	});

	it("does not throw or log sensitive details if the SMTP transport errors", async () => {
		resetEnv();
		process.env.NODE_ENV = "production";
		envMock.SMTP_HOST = "smtp.example.com";
		envMock.SMTP_USER = "user";
		envMock.SMTP_PASS = "pass";
		envMock.SMTP_FROM = "noreply@example.com";
		sendMail.mockRejectedValueOnce(new Error("SMTP rejected password=secret reset-token=private"));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(sendEmail({ to: "a@b.com", subject: "hi", react: fakeReact })).resolves.toBeUndefined();
		expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
		expect(errorSpy).toHaveBeenCalledExactlyOnceWith("There was an error sending mail.");
		errorSpy.mockRestore();
	});
});

// CAREEROS: the sender display name defaults to the platform name (P2-T08).
describe("withDisplayName", () => {
	it("adds the platform name to a bare address", () => {
		expect(withDisplayName("noreply@example.com")).toBe('"CareerOS" <noreply@example.com>');
	});

	it("uses a given name and strips characters that could break the header", () => {
		expect(withDisplayName("noreply@example.com", 'Acme "Careers"')).toBe('"Acme Careers" <noreply@example.com>');
		expect(withDisplayName("noreply@example.com", "A\\B <x@y.z>")).toBe('"AB x@y.z" <noreply@example.com>');
	});

	// P2-T04: header injection through the organization's sender name.
	it("turns a header-injection attempt into one clean header", () => {
		const header = withDisplayName("noreply@example.com", '"x\r\nBcc: a@b.c');
		expect(header).toBe('"xBcc: a@b.c" <noreply@example.com>');
		expect(header).not.toMatch(/[\r\n]/);
		expect(header?.match(/</g)).toHaveLength(1);
	});

	it("strips control characters and angle brackets, and caps the name at 64 characters", () => {
		expect(cleanDisplayName("a\u0000b\u007fc\td<e>f")).toBe("abcdef");
		expect(cleanDisplayName("x".repeat(100))).toHaveLength(64);
	});

	it("falls back to the platform name when nothing is left", () => {
		expect(withDisplayName("noreply@example.com", '"<>\r\n')).toBe('"CareerOS" <noreply@example.com>');
		expect(withDisplayName("noreply@example.com", null)).toBe('"CareerOS" <noreply@example.com>');
	});

	it("keeps an address that already has a display name", () => {
		expect(withDisplayName("Me <me@example.com>")).toBe("Me <me@example.com>");
	});

	it("passes through an unset address", () => {
		expect(withDisplayName(undefined)).toBeUndefined();
	});
});

describe("safeReplyTo", () => {
	it("keeps one bare address and drops everything else", () => {
		expect(safeReplyTo("help@example.com")).toBe("help@example.com");
		expect(safeReplyTo("a@b.c\r\nBcc: x@y.z")).toBeUndefined();
		expect(safeReplyTo("A <a@b.c>")).toBeUndefined();
		expect(safeReplyTo("a@b.c, d@e.f")).toBeUndefined();
		expect(safeReplyTo(null)).toBeUndefined();
	});
});

describe("sender and reply-to on the wire", () => {
	const configure = () => {
		resetEnv();
		envMock.SMTP_HOST = "smtp.example.com";
		envMock.SMTP_USER = "user";
		envMock.SMTP_PASS = "pass";
		envMock.SMTP_FROM = "noreply@example.com";
	};

	it("sends the verified address with the organization's name and reply-to", async () => {
		configure();
		await sendEmail({
			to: "a@b.com",
			subject: "Verify\r\nBcc: x@y.z",
			react: fakeReact,
			fromName: 'Acme "Careers"\r\nBcc: a@b.c',
			replyTo: "help@acme.example",
		});
		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				from: '"Acme CareersBcc: a@b.c" <noreply@example.com>',
				replyTo: "help@acme.example",
				subject: "Verify Bcc: x@y.z",
			}),
		);
	});

	it("leaves the Reply-To out when it is unset or invalid", async () => {
		configure();
		await sendEmail({ to: "a@b.com", subject: "hi", react: fakeReact, replyTo: "a@b.c\r\nBcc: x@y.z" });
		expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("replyTo");
	});

	it("builds career notification Message-IDs on the host of APP_URL, not an upstream domain", async () => {
		configure();
		await sendCareerNotification({
			to: "a@b.com",
			subject: "Update",
			text: "Hello",
			url: "/career",
			key: "k1",
			fromName: "Acme",
			replyTo: "help@acme.example",
		});
		const mail = sendMail.mock.calls[0]?.[0] as { messageId: string; from: string; replyTo: string };
		expect(mail.messageId).toMatch(/^<career-[0-9a-f]{64}@careers\.example\.com>$/);
		expect(mail.from).toBe('"Acme" <noreply@example.com>');
		expect(mail.replyTo).toBe("help@acme.example");
	});

	it("still refuses a career link that points away from the application", async () => {
		configure();
		await expect(
			sendCareerNotification({ to: "a@b.com", subject: "x", text: "y", url: "https://evil.example/", key: "k" }),
		).rejects.toThrow(/this application/);
	});
});
