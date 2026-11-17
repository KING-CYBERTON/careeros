import { describe, expect, it } from "vite-plus/test";
import ashbyFixture from "../fixtures/ashby.json";
import greenhouseFixture from "../fixtures/greenhouse.json";
import leverFixture from "../fixtures/lever.json";
import { ashby, FETCHERS, greenhouse, lever, leverEu } from "./sources";
import { BOARD_SOURCES, BoardFetchError, boardListSchema, boardRefSchema, boardTokenSchema } from "./types";

describe("board tokens", () => {
	it.each(["acme", "Acme-Corp", "a", "ab_c-9", "x".repeat(100)])("accepts %s", (token) => {
		expect(boardTokenSchema.safeParse(token).success).toBe(true);
	});

	it.each([
		"",
		"-acme",
		"_acme",
		"../etc/passwd",
		"acme/../x",
		"acme%2F..%2Fx",
		"%2e%2e",
		"user@evil.test",
		"acme?x=1",
		"acme#frag",
		"acme.evil.test",
		"acme:8080",
		"https://evil.test",
		"acme evil",
		"acme\nevil",
		"x".repeat(101),
		"émile",
	])("refuses %j", (token) => {
		expect(boardTokenSchema.safeParse(token).success).toBe(false);
	});

	it("refuses an unknown source and a URL in place of a token", () => {
		expect(boardRefSchema.safeParse({ source: "workday", token: "acme" }).success).toBe(false);
		expect(boardRefSchema.safeParse({ source: "lever", token: "https://api.lever.co/v0/postings/acme" }).success).toBe(
			false,
		);
	});

	it("allows at most 100 boards", () => {
		const board = (index: number) => ({ source: "greenhouse" as const, token: `acme-${index}` });
		expect(boardListSchema.safeParse(Array.from({ length: 100 }, (_, index) => board(index))).success).toBe(true);
		expect(boardListSchema.safeParse(Array.from({ length: 101 }, (_, index) => board(index))).success).toBe(false);
	});
});

describe("fetch URLs", () => {
	it("are a fixed base plus the encoded token, per source", () => {
		expect(greenhouse.buildUrl("acme")).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
		expect(lever.buildUrl("acme")).toBe("https://api.lever.co/v0/postings/acme?mode=json");
		expect(leverEu.buildUrl("acme")).toBe("https://api.eu.lever.co/v0/postings/acme?mode=json");
		expect(ashby.buildUrl("acme")).toBe("https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true");
	});

	it("encode the token, so even an unvalidated one cannot change the path or host", () => {
		for (const fetcher of Object.values(FETCHERS)) {
			const url = new URL(fetcher.buildUrl("../a/b@evil.test?x=1#y"));
			expect(url.hostname).toBe(fetcher.host);
			expect(url.username).toBe("");
			expect(url.hash).toBe("");
			// The dots stay (encodeURIComponent leaves them), but inside one segment: no segment is a traversal.
			expect(url.pathname.split("/")).not.toContain("..");
			expect(url.pathname.split("/").filter(Boolean).length).toBeLessThanOrEqual(4);
		}
	});

	it("exist for every source", () => {
		expect(Object.keys(FETCHERS).sort()).toEqual([...BOARD_SOURCES].sort());
	});
});

describe("Greenhouse normalizer", () => {
	const jobs = greenhouse.normalize("examplelabs", greenhouseFixture);

	it("keeps the usable postings and drops the one with an insecure address", () => {
		expect(jobs.map((job) => job.externalId)).toEqual(["4001001", "4001002"]);
	});

	it("reads the fields", () => {
		expect(jobs[0]).toMatchObject({
			source: "greenhouse",
			boardToken: "examplelabs",
			title: "Senior Backend Engineer",
			company: "Example Labs",
			location: "Remote - Europe",
			remote: "remote",
			url: "https://boards.greenhouse.io/examplelabs/jobs/4001001",
		});
		expect(jobs[0]?.postedAt?.toISOString()).toBe("2026-10-01T16:00:00.000Z");
		expect(jobs[1]?.remote).toBeNull();
	});

	it("unescapes and then sanitizes the description", () => {
		const html = jobs[0]?.descriptionHtml ?? "";
		expect(html).toContain("<h2>About the role</h2>");
		expect(html).toContain("<strong>TypeScript</strong>");
		expect(html).toContain("<li>Own APIs</li>");
		expect(html).toContain('<a href="https://example.test/apply" rel="noopener nofollow">Apply</a>');
		expect(html).not.toMatch(/<script|alert|javascript:|onclick/i);
	});

	it("refuses an answer that is not the documented shape", () => {
		expect(() => greenhouse.normalize("x", [])).toThrow(BoardFetchError);
		expect(() => greenhouse.normalize("x", { jobs: "nope" })).toThrow(BoardFetchError);
	});
});

describe("Lever normalizer", () => {
	const jobs = lever.normalize("examplelabs", leverFixture);

	it("keeps the usable postings and drops the one without a title", () => {
		expect(jobs.map((job) => job.externalId)).toEqual([
			"11111111-2222-3333-4444-555555555555",
			"66666666-7777-8888-9999-000000000000",
		]);
	});

	it("reads the fields, with the site name standing in for the company", () => {
		expect(jobs[0]).toMatchObject({
			source: "lever",
			title: "Staff Data Engineer",
			company: "examplelabs",
			location: "London",
			remote: "hybrid",
		});
		expect(jobs[0]?.postedAt?.getTime()).toBe(1_760_000_000_000);
		expect(jobs[1]?.remote).toBe("remote");
	});

	it("joins the description, the lists and the closing text, sanitized", () => {
		const html = jobs[0]?.descriptionHtml ?? "";
		expect(html).toContain("<strong>data pipelines</strong>");
		expect(html).toContain("<h3>Requirements</h3>");
		expect(html).toContain("<li>Python</li>");
		expect(html).toContain("equal opportunity employer");
		expect(html).not.toContain("<div");
	});

	it("the EU instance reads the same shape under its own source", () => {
		const eu = leverEu.normalize("examplelabs", leverFixture);
		expect(eu.every((job) => job.source === "lever_eu")).toBe(true);
		expect(eu).toHaveLength(2);
	});

	it("refuses an answer that is not a list", () => {
		expect(() => lever.normalize("x", { jobs: [] })).toThrow(BoardFetchError);
	});
});

describe("Ashby normalizer", () => {
	const jobs = ashby.normalize("examplelabs", ashbyFixture);

	it("skips the posting that is not listed", () => {
		expect(jobs.map((job) => job.title)).toEqual(["Product Designer", "Security Engineer"]);
	});

	it("reads the workplace type and falls back to isRemote", () => {
		expect(jobs[0]?.remote).toBe("onsite");
		expect(jobs[1]?.remote).toBe("remote");
		expect(jobs[0]?.location).toBe("Berlin, Germany");
		expect(jobs[0]?.company).toBe("examplelabs");
	});

	it("drops images and frames from the description", () => {
		const html = jobs[0]?.descriptionHtml ?? "";
		expect(html).toBe("<h3>Role</h3><p>Design <em>delightful</em> interfaces.</p>");
	});

	it("refuses an answer that is not the documented shape", () => {
		expect(() => ashby.normalize("x", [])).toThrow(BoardFetchError);
	});
});
