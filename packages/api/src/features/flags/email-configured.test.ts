import { expect, it } from "vite-plus/test";
import { isEmailConfigured } from "./email-configured";

const smtp = { SMTP_HOST: "mail.example.test", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "a@example.test" };

it("counts a complete Plunk setup", () => {
	expect(
		isEmailConfigured({ EMAIL_PROVIDER: "plunk", PLUNK_SECRET_KEY: "sk_test", EMAIL_FROM_ADDRESS: "a@example.test" }),
	).toBe(true);
});
it("does not count Plunk without its key or from address", () => {
	expect(isEmailConfigured({ EMAIL_PROVIDER: "plunk", EMAIL_FROM_ADDRESS: "a@example.test" })).toBe(false);
	expect(isEmailConfigured({ EMAIL_PROVIDER: "plunk", PLUNK_SECRET_KEY: "sk_test" })).toBe(false);
});
it("does not count the log provider even with SMTP variables", () => {
	expect(isEmailConfigured({ EMAIL_PROVIDER: "log", ...smtp })).toBe(false);
});
it("counts the smtp provider", () => {
	expect(isEmailConfigured({ EMAIL_PROVIDER: "smtp", ...smtp })).toBe(true);
});
it("counts complete SMTP with no provider chosen", () => {
	expect(isEmailConfigured({ ...smtp })).toBe(true);
	expect(isEmailConfigured({ ...smtp, SMTP_PASS: undefined })).toBe(false);
});
it("is false when nothing is configured", () => {
	expect(isEmailConfigured({})).toBe(false);
});
