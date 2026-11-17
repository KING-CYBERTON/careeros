import { describe, expect, it } from "vite-plus/test";
import { buildMailto, copyText, isMailableAddress, MAILTO_MAX_LENGTH } from "./mailto";

describe("buildMailto", () => {
	it("puts the contact's address, the subject and the body in the link, URL-encoded", () => {
		const result = buildMailto({ to: "sam@acme.test", subject: "Thank you & more", body: "Line one\nLine two" });
		expect(result).toEqual({
			mode: "mailto",
			url: "mailto:sam@acme.test?subject=Thank%20you%20%26%20more&body=Line%20one%0D%0ALine%20two",
		});
	});

	it("leaves the recipient out when the contact's address is unknown or unsafe", () => {
		for (const to of [undefined, null, "", "not an address", "a@b.test,c@d.test", "x@y.test?cc=boss@z.test"]) {
			const result = buildMailto({ to, subject: "Hi", body: "Body" });
			expect(result).toEqual({ mode: "mailto", url: "mailto:?subject=Hi&body=Body" });
		}
	});

	it("cannot inject a header through the subject", () => {
		const result = buildMailto({ to: "sam@acme.test", subject: "Hi\r\nBcc: spy@x.test", body: "b" });
		expect(result.mode === "mailto" && result.url).toBe(
			"mailto:sam@acme.test?subject=Hi%20Bcc%3A%20spy%40x.test&body=b",
		);
	});

	it("falls back to copy when the link would be longer than 1 800 characters", () => {
		const exactly = (length: number) => {
			const base = buildMailto({ subject: "S", body: "" });
			const fixed = base.mode === "mailto" ? base.url.length : 0;
			return "a".repeat(length - fixed);
		};
		const atLimit = buildMailto({ subject: "S", body: exactly(MAILTO_MAX_LENGTH) });
		expect(atLimit.mode).toBe("mailto");
		expect(atLimit.mode === "mailto" && atLimit.url.length).toBe(MAILTO_MAX_LENGTH);
		expect(buildMailto({ subject: "S", body: exactly(MAILTO_MAX_LENGTH + 1) })).toEqual({
			mode: "copy",
			reason: "too_long",
		});
	});

	it("counts the encoded length, so a short text of accented letters can still be too long", () => {
		expect(buildMailto({ subject: "S", body: "é".repeat(400) }).mode).toBe("copy");
		expect(buildMailto({ subject: "S", body: "e".repeat(400) }).mode).toBe("mailto");
	});
});

describe("isMailableAddress", () => {
	it("accepts one plain address only", () => {
		expect(isMailableAddress("sam@acme.test")).toBe(true);
		expect(isMailableAddress(" sam@acme.test ")).toBe(true);
		expect(isMailableAddress("sam@acme")).toBe(false);
		expect(isMailableAddress("a@b.c d@e.f")).toBe(false);
	});
});

describe("copyText", () => {
	it("puts the subject first", () => {
		expect(copyText({ subject: "Hello", body: "Body" })).toBe("Hello\n\nBody");
	});
});
