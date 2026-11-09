import { describe, expect, it } from "vite-plus/test";
import { parseBoardUrl } from "./board-url";

const board = (source: string, token: string) => ({ kind: "board", board: { source, token } });

describe("parseBoardUrl", () => {
	it.each([
		["https://boards.greenhouse.io/acme", board("greenhouse", "acme")],
		["https://job-boards.greenhouse.io/acme-corp/jobs/12345", board("greenhouse", "acme-corp")],
		["https://boards.greenhouse.io/embed/job_board?for=acme", board("greenhouse", "acme")],
		["https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true", board("greenhouse", "acme")],
		["https://jobs.lever.co/acme", board("lever", "acme")],
		["https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666?lever-source=x", board("lever", "acme")],
		["https://api.lever.co/v0/postings/acme?mode=json", board("lever", "acme")],
		["https://jobs.eu.lever.co/acme", board("lever_eu", "acme")],
		["https://api.eu.lever.co/v0/postings/acme", board("lever_eu", "acme")],
		["https://jobs.ashbyhq.com/acme", board("ashby", "acme")],
		["https://jobs.ashbyhq.com/acme/9f8e7d6c?utm_source=x#apply", board("ashby", "acme")],
		["https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true", board("ashby", "acme")],
	])("reads %s", (input, expected) => {
		expect(parseBoardUrl(input)).toEqual(expected);
	});

	it("accepts a URL without a scheme, in any letter case, and surrounding spaces", () => {
		expect(parseBoardUrl("  Jobs.Lever.co/Acme  ")).toEqual(board("lever", "Acme"));
		expect(parseBoardUrl("http://jobs.ashbyhq.com/acme")).toEqual(board("ashby", "acme"));
	});

	it("keeps an underscore and a digit in a token", () => {
		expect(parseBoardUrl("https://boards.greenhouse.io/acme_2")).toEqual(board("greenhouse", "acme_2"));
	});

	it.each([
		"https://www.linkedin.com/jobs/view/123",
		"https://example.com/acme",
		"https://boards.greenhouse.io.evil.com/acme",
		"https://evil.com/jobs.lever.co/acme",
		"https://jobs.workable.com/acme",
		"ftp://jobs.lever.co/acme",
		"https://user:pass@jobs.lever.co/acme",
		"https://jobs.lever.co:8443/acme",
	])("says %s is unsupported", (input) => {
		expect(parseBoardUrl(input)).toEqual({ kind: "unsupported" });
	});

	it("finds no token on a supported host with no board name", () => {
		expect(parseBoardUrl("https://boards.greenhouse.io/")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://jobs.lever.co")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://api.lever.co/v0/postings/")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://api.ashbyhq.com/other/acme")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://boards.greenhouse.io/%2e%2e%2fadmin")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://boards.greenhouse.io/ac%40me")).toEqual({ kind: "no_token" });
		expect(parseBoardUrl("https://boards.greenhouse.io/%E0%A4%A")).toEqual({ kind: "no_token" });
	});

	it("leaves plain tokens and junk alone", () => {
		for (const input of ["", "   ", "acme", "acme-corp_2", "not a url", "hello world.com"])
			expect(parseBoardUrl(input)).toEqual({ kind: "not_url" });
	});

	it("never throws on junk", () => {
		for (const input of ["http://", "https://[", "//", "https:///x", "a://b://c", "\u0000", "https://%"])
			expect(() => parseBoardUrl(input)).not.toThrow();
	});
});
