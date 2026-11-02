import { describe, expect, it } from "vite-plus/test";
import { isDevHttpHost, normalizeOrigin, permissionPattern } from "./address";

const origin = (input: string, devHttpHosts: readonly string[] = []) => {
	const result = normalizeOrigin(input, devHttpHosts);
	return result.ok ? result.origin : result.reason;
};

describe("normalizeOrigin", () => {
	it("accepts a bare host", () => {
		expect(origin("careers.example.org")).toBe("https://careers.example.org");
	});

	it("accepts an https URL", () => {
		expect(origin("https://careers.example.org")).toBe("https://careers.example.org");
	});

	it("drops trailing paths, queries and fragments", () => {
		expect(origin("https://careers.example.org/")).toBe("https://careers.example.org");
		expect(origin("https://careers.example.org/jobs/42?ref=x#top")).toBe("https://careers.example.org");
		expect(origin("careers.example.org/jobs")).toBe("https://careers.example.org");
	});

	it("lowercases the host and the scheme", () => {
		expect(origin("Careers.EXAMPLE.org")).toBe("https://careers.example.org");
		expect(origin("HTTPS://Careers.Example.ORG/Path")).toBe("https://careers.example.org");
	});

	it("trims spaces and a trailing dot", () => {
		expect(origin("  careers.example.org  ")).toBe("https://careers.example.org");
		expect(origin("careers.example.org.")).toBe("https://careers.example.org");
	});

	it("turns an international name into punycode", () => {
		expect(origin("bücher.example")).toBe("https://xn--bcher-kva.example");
		expect(origin("https://Bücher.Example/seite")).toBe("https://xn--bcher-kva.example");
	});

	it("keeps a non-default port and drops the default one", () => {
		expect(origin("careers.example.org:8443")).toBe("https://careers.example.org:8443");
		expect(origin("https://careers.example.org:443")).toBe("https://careers.example.org");
	});

	it("refuses an empty value", () => {
		expect(origin("")).toBe("empty");
		expect(origin("   ")).toBe("empty");
	});

	it("refuses text that is not an address", () => {
		expect(origin("not an address")).toBe("invalid");
		expect(origin("https://")).toBe("invalid");
		expect(origin("javascript:alert(1)")).toBe("invalid");
	});

	it("refuses other schemes", () => {
		expect(origin("ftp://careers.example.org")).toBe("scheme");
		expect(origin("chrome-extension://abcdef/popup.html")).toBe("scheme");
		expect(origin("file:///etc/passwd")).toBe("scheme");
	});

	it("refuses user info", () => {
		expect(origin("https://user:secret@careers.example.org")).toBe("credentials");
		expect(origin("user@careers.example.org")).toBe("credentials");
	});

	it("refuses http in a production build", () => {
		expect(origin("http://careers.example.org")).toBe("insecure");
		// A production build has no development host: localhost is a single-label name, so it is refused outright.
		expect(origin("http://localhost:3000")).toBe("host");
	});

	it("refuses single-label names and IP addresses", () => {
		expect(origin("intranet")).toBe("host");
		expect(origin("localhost")).toBe("host");
		expect(origin("https://127.0.0.1")).toBe("host");
		expect(origin("https://192.168.1.10:3000")).toBe("host");
		expect(origin("https://[::1]")).toBe("host");
		expect(origin("https://2130706433")).toBe("host");
	});
});

describe("normalizeOrigin in a development build", () => {
	const dev = ["localhost"];

	it("accepts http for localhost, with or without a scheme", () => {
		expect(origin("http://localhost:3000", dev)).toBe("http://localhost:3000");
		expect(origin("localhost:3000", dev)).toBe("http://localhost:3000");
		expect(origin("localhost", dev)).toBe("http://localhost");
		expect(origin("HTTP://LocalHost:3000/app", dev)).toBe("http://localhost:3000");
	});

	it("keeps port 443 for a bare localhost", () => {
		expect(origin("localhost:443", dev)).toBe("http://localhost:443");
	});

	it("still refuses http for any other host", () => {
		expect(origin("http://careers.example.org", dev)).toBe("insecure");
		expect(origin("http://localhost.example.org", dev)).toBe("insecure");
		expect(origin("http://127.0.0.1:3000", dev)).toBe("host");
	});

	it("still accepts https hosts", () => {
		expect(origin("careers.example.org", dev)).toBe("https://careers.example.org");
	});

	it("accepts a listed wildcard suffix", () => {
		const wildcard = ["localhost", "*.orgs.test"];
		expect(origin("http://acme.orgs.test:3000", wildcard)).toBe("http://acme.orgs.test:3000");
		expect(origin("acme.orgs.test:3000", wildcard)).toBe("http://acme.orgs.test:3000");
		expect(origin("http://orgs.test", wildcard)).toBe("insecure");
		expect(origin("http://evilorgs.test", wildcard)).toBe("insecure");
	});
});

describe("isDevHttpHost", () => {
	it("matches exact hosts and subdomains of a wildcard only", () => {
		expect(isDevHttpHost("localhost", ["localhost"])).toBe(true);
		expect(isDevHttpHost("a.localhost", ["localhost"])).toBe(false);
		expect(isDevHttpHost("a.orgs.test", ["*.orgs.test"])).toBe(true);
		expect(isDevHttpHost("orgs.test", ["*.orgs.test"])).toBe(false);
		expect(isDevHttpHost("anything.example", [])).toBe(false);
	});
});

describe("permissionPattern", () => {
	it("asks for the whole origin and nothing else", () => {
		expect(permissionPattern("https://careers.example.org")).toBe("https://careers.example.org/*");
	});
});
