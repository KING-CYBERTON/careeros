import { afterEach, describe, expect, it } from "vite-plus/test";
import { isUnknownOrganization } from "./org-not-found";

const flagGlobal = globalThis as { __ORG_NOT_FOUND__?: unknown };

afterEach(() => {
	delete flagGlobal.__ORG_NOT_FOUND__;
});

describe("isUnknownOrganization", () => {
	it("is false unless the server set the flag to true", () => {
		expect(isUnknownOrganization()).toBe(false);
		flagGlobal.__ORG_NOT_FOUND__ = "true";
		expect(isUnknownOrganization()).toBe(false);
		flagGlobal.__ORG_NOT_FOUND__ = true;
		expect(isUnknownOrganization()).toBe(true);
	});
});
