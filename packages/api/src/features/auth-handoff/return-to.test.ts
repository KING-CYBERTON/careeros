import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RETURN_TO, sanitizeReturnTo } from "./return-to";

// P2-T05, requirement 3: the return path of a handoff is a plain path on the organization's own origin.
const ORIGIN = "https://acme.example.test";

describe("sanitizeReturnTo", () => {
	it.each([
		["a protocol-relative URL", "//evil.com"],
		["a backslash after the slash", "/\\evil.com"],
		["an absolute URL", "https://evil.com"],
		["an encoded protocol-relative URL", "/%2F%2Fevil.com"],
		["an encoded backslash", "/%5Cevil.com"],
		["a javascript: URL", "javascript:alert(1)"],
		["a data: URL", "data:text/html,x"],
		["a path with CR and LF", "/dashboard\r\nSet-Cookie: x=1"],
		["a tab", "/dash\tboard"],
		["a null byte", "/dash\u0000board"],
		["a path of 600 characters", `/${"a".repeat(599)}`],
		["a double slash inside the path", "/a//b"],
		["a double slash inside the query", "/resumes?next=https://evil.com"],
		["a user-info look-alike", "@evil.com/path"],
		["an empty string", ""],
		["a relative path without a leading slash", "dashboard"],
		["a malformed escape", "/%E0%A4%A"],
		["a number", 7],
		["undefined", undefined],
		["null", null],
		["an object", { path: "/x" }],
	])("turns %s into /dashboard", (_name, value) => {
		expect(sanitizeReturnTo(value, ORIGIN)).toBe(DEFAULT_RETURN_TO);
	});

	it.each(["/resumes?x=1", "/dashboard", "/builder/abc123", "/a/b/c#section", `/${"a".repeat(511)}`, "/"])(
		"keeps %s",
		(value) => {
			expect(sanitizeReturnTo(value, ORIGIN)).toBe(value);
		},
	);

	it("keeps a path of exactly 512 characters and refuses 513", () => {
		expect(sanitizeReturnTo(`/${"a".repeat(511)}`, ORIGIN)).toHaveLength(512);
		expect(sanitizeReturnTo(`/${"a".repeat(512)}`, ORIGIN)).toBe(DEFAULT_RETURN_TO);
	});

	it("resolves against the target origin, including a port", () => {
		expect(sanitizeReturnTo("/resumes", "http://acme.orgs.test:3000")).toBe("/resumes");
	});
});
