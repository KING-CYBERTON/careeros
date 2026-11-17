import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// P6-T02: the test send mails the address it is given and writes one non-admin.* audit row without the address.

const execute = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }));
const sendTestEmail = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/db/client", () => ({ db: { execute } }));
vi.mock("@reactive-resume/email/test-send", () => ({ sendTestEmail }));
vi.mock("drizzle-orm", () => ({
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values }),
}));

const { sendTestEmailToAdmin } = await import("./email-test");

beforeEach(() => {
	execute.mockClear();
	sendTestEmail.mockReset();
});

describe("sendTestEmailToAdmin", () => {
	it("returns queued and audits email.test_sent with no address", async () => {
		sendTestEmail.mockResolvedValue({ provider: "plunk", outcome: "queued", emailId: "email_1" });
		await expect(sendTestEmailToAdmin("admin-1", "admin@example.test")).resolves.toEqual({
			provider: "plunk",
			outcome: "queued",
		});
		expect(sendTestEmail).toHaveBeenCalledWith("admin@example.test");
		const audit = execute.mock.calls[0]?.[0] as { text: string; values: unknown[] };
		expect(audit.text).toContain("careeros_audit_platform");
		expect(audit.text).toContain("'email.test_sent'");
		expect(audit.text).not.toContain("'admin.");
		expect(JSON.stringify(audit.values)).not.toContain("admin@example.test");
	});

	it("returns the error code and status of a failed send, and audits it", async () => {
		sendTestEmail.mockResolvedValue({ provider: "plunk", outcome: "failed", code: "plan_limit", status: 402 });
		await expect(sendTestEmailToAdmin("admin-1", "admin@example.test")).resolves.toEqual({
			provider: "plunk",
			outcome: "failed",
			code: "plan_limit",
			status: 402,
		});
		const audit = execute.mock.calls[0]?.[0] as { values: unknown[] };
		expect(JSON.stringify(audit.values)).toContain("plan_limit");
	});
});
