import { describe, expect, it } from "vite-plus/test";
import { aiCallBudget, parseAiMatchOutput, selectTopN } from "./ai";
import { descriptionToText } from "./sanitize";

describe("parseAiMatchOutput", () => {
	it("accepts a score from 0 to 100 and a plain summary, rounding the score to two decimals", () => {
		expect(parseAiMatchOutput({ score: 0, summary: "No." })).toEqual({ score: 0, summary: "No." });
		expect(parseAiMatchOutput({ score: 100, summary: "Ideal." })).toEqual({ score: 100, summary: "Ideal." });
		expect(parseAiMatchOutput({ score: 77.456, summary: "  Good fit.  " })).toEqual({
			score: 77.46,
			summary: "Good fit.",
		});
	});

	it("accepts a summary of exactly 280 characters and refuses 281", () => {
		expect(parseAiMatchOutput({ score: 50, summary: "a".repeat(280) })).not.toBeNull();
		expect(parseAiMatchOutput({ score: 50, summary: "a".repeat(281) })).toBeNull();
	});

	it.each([
		["a score above 100", { score: 100.1, summary: "x" }],
		["a negative score", { score: -1, summary: "x" }],
		["a score that is text", { score: "80", summary: "x" }],
		["a score that is not finite", { score: Number.POSITIVE_INFINITY, summary: "x" }],
		["an empty summary", { score: 5, summary: "   " }],
		["a missing summary", { score: 5 }],
		["markup in the summary", { score: 5, summary: "Fine <b>fit</b>" }],
		["a script tag", { score: 5, summary: "<script>x</script>" }],
		["a control character", { score: 5, summary: "bad\u0000text" }],
		["null", null],
		["a string", "score 5"],
	])("refuses %s", (_name, value) => {
		expect(parseAiMatchOutput(value)).toBeNull();
	});

	it("keeps ordinary punctuation and comparisons that are not tags", () => {
		expect(parseAiMatchOutput({ score: 5, summary: "5 > 3 years, salary < 100k & remote" })).not.toBeNull();
	});
});

describe("aiCallBudget", () => {
	it("is the smaller of the automation's ai_top_n and the plan cap", () => {
		expect(aiCallBudget(10, 25)).toBe(10);
		expect(aiCallBudget(50, 25)).toBe(25);
		expect(aiCallBudget(0, 25)).toBe(0);
		expect(aiCallBudget(10, 0)).toBe(0);
	});

	it("is never negative or fractional", () => {
		expect(aiCallBudget(-3, 25)).toBe(0);
		expect(aiCallBudget(10.9, 25)).toBe(10);
		expect(aiCallBudget(Number.NaN, 25)).toBe(0);
	});
});

describe("selectTopN", () => {
	const jobs = [
		{ id: "c", localScore: 40 },
		{ id: "a", localScore: 90 },
		{ id: "b", localScore: 90 },
		{ id: "d", localScore: 10 },
	];

	it("takes the best N by local score, ties by id", () => {
		expect(selectTopN(jobs, 3).map((job) => job.id)).toEqual(["a", "b", "c"]);
	});

	it("takes all when N is larger, none when it is zero, and leaves the input alone", () => {
		expect(selectTopN(jobs, 99)).toHaveLength(4);
		expect(selectTopN(jobs, 0)).toEqual([]);
		expect(jobs.map((job) => job.id)).toEqual(["c", "a", "b", "d"]);
	});
});

describe("descriptionToText", () => {
	it("makes readable plain text from sanitized HTML and never returns markup", () => {
		const text = descriptionToText(
			'<h2>Role</h2><p>Build &amp; ship <strong>APIs</strong></p><ul><li>One</li><li>Two</li></ul><a href="https://x.test">link</a>',
		);
		expect(text).toBe("Role\nBuild & ship APIs\n\n- One\n- Two\n\nlink");
		expect(text).not.toMatch(/<|>/);
	});

	it("cuts to the limit", () => {
		expect(descriptionToText(`<p>${"a".repeat(500)}</p>`, 100)).toHaveLength(100);
	});
});
