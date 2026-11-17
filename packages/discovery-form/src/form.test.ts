import { describe, expect, it } from "vite-plus/test";
import {
	addTerms,
	draftFromSource,
	emptyDraft,
	hasErrors,
	readServerFormError,
	removeTerm,
	validateDraft,
	type SearchDraft,
} from "./form";
import { sourceCreateSchema, sourceUpdateSchema } from "./schema";

const draft = (patch: Partial<SearchDraft> = {}): SearchDraft => ({ ...emptyDraft(), name: "Product roles", ...patch });
const errorsOf = (result: ReturnType<typeof validateDraft>) => (result.ok ? undefined : result.errors);

describe("validateDraft", () => {
	it("accepts a minimal draft and fills the server defaults", () => {
		const result = validateDraft(draft());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toMatchObject({ name: "Product roles", remote: "any", schedule: "daily" });
	});

	it("requires a name and caps it at 120 characters", () => {
		expect(errorsOf(validateDraft(draft({ name: "   " })))?.fields.name).toBe("name_required");
		expect(validateDraft(draft({ name: "a".repeat(120) })).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ name: "a".repeat(121) })))?.fields.name).toBe("name_too_long");
	});

	it("limits each chip list to 50 entries of 100 characters", () => {
		const fifty = Array.from({ length: 50 }, (_, index) => `skill ${index}`);
		expect(validateDraft(draft({ skills: fifty })).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ skills: [...fifty, "one more"] })))?.fields.skills).toBe("too_many_terms");
		expect(validateDraft(draft({ titles: ["a".repeat(100)] })).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ titles: ["a".repeat(101)] })))?.fields.titles).toBe("term_too_long");
	});

	it("removes case-insensitive duplicates the way the server does", () => {
		const result = validateDraft(draft({ keywords: ["React", "react", " REACT ", "Node"] }));
		expect(result.ok && result.value.keywords).toEqual(["React", "Node"]);
	});

	it("reports a board row without a token or with a malformed one on that row", () => {
		const result = validateDraft(
			draft({
				boards: [
					{ source: "greenhouse", token: "acme" },
					{ source: "lever", token: "" },
					{ source: "ashby", token: "../etc" },
				],
			}),
		);
		expect(errorsOf(result)?.boardRows).toEqual({ 1: "token_required", 2: "token_invalid" });
	});

	it("keeps one row for a repeated board", () => {
		const result = validateDraft(
			draft({
				boards: [
					{ source: "greenhouse", token: "Acme" },
					{ source: "greenhouse", token: "acme" },
					{ source: "lever", token: "acme" },
				],
			}),
		);
		expect(result.ok && result.value.boards).toHaveLength(2);
	});

	it("allows at most 100 boards", () => {
		const boards = (count: number) =>
			Array.from({ length: count }, (_, i) => ({ source: "greenhouse" as const, token: `b${i}` }));
		expect(validateDraft(draft({ boards: boards(100) })).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ boards: boards(101) })))?.fields.boards).toBe("too_many_boards");
	});

	it("checks the AI count against 0 to 50 and against the plan cap", () => {
		expect(validateDraft(draft({ aiTopN: 0 })).ok).toBe(true);
		expect(validateDraft(draft({ aiTopN: 50 })).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ aiTopN: 51 })))?.fields.aiTopN).toBe("ai_top_n_invalid");
		expect(errorsOf(validateDraft(draft({ aiTopN: -1 })))?.fields.aiTopN).toBe("ai_top_n_invalid");
		expect(errorsOf(validateDraft(draft({ aiTopN: 2.5 })))?.fields.aiTopN).toBe("ai_top_n_invalid");
		expect(validateDraft(draft({ aiTopN: 25 }), { maxAiTopN: 25 }).ok).toBe(true);
		expect(errorsOf(validateDraft(draft({ aiTopN: 26 }), { maxAiTopN: 25 }))?.fields.aiTopN).toBe("ai_top_n_over_cap");
	});

	it("agrees with the server create schema on every draft it judges", () => {
		const drafts = [
			draft(),
			draft({ name: "" }),
			draft({ name: "x".repeat(121) }),
			draft({ titles: [""] }),
			draft({ aiTopN: 51 }),
			draft({ boards: [{ source: "lever_eu", token: "-bad" }] }),
			draft({ boards: [{ source: "lever_eu", token: "ok-1" }], schedule: "paused", remote: "hybrid" }),
		];
		for (const item of drafts) expect(validateDraft(item).ok).toBe(sourceCreateSchema.safeParse(item).success);
	});
});

describe("update schema", () => {
	it("does not reset a field the patch leaves out", () => {
		expect(sourceUpdateSchema.parse({ id: "s1", name: "New name" })).toEqual({ id: "s1", name: "New name" });
	});
});

describe("addTerms", () => {
	it("splits on commas and line breaks, trims, skips empties and duplicates", () => {
		expect(addTerms(["React"], " react, Node ,, TypeScript\nnode")).toEqual({ terms: ["React", "Node", "TypeScript"] });
	});

	it("refuses an entry over 100 characters and keeps the rest", () => {
		const result = addTerms([], `${"a".repeat(101)}, ok`);
		expect(result).toEqual({ terms: ["ok"], error: "term_too_long" });
	});

	it("refuses an entry past the 50th", () => {
		const full = Array.from({ length: 50 }, (_, index) => `t${index}`);
		expect(addTerms(full, "extra")).toEqual({ terms: full, error: "too_many_terms" });
		expect(addTerms(full, "T3")).toEqual({ terms: full });
	});

	it("removes a chip", () => {
		expect(removeTerm(["a", "b"], "a")).toEqual(["b"]);
	});
});

describe("readServerFormError", () => {
	it("maps oRPC input issues to fields and board rows", () => {
		const read = readServerFormError({
			code: "BAD_REQUEST",
			data: {
				issues: [
					{ code: "too_big", path: ["name"] },
					{ code: "invalid_format", path: ["boards", 1, "token"] },
					{ code: "too_big", path: [{ key: "titles" }] },
				],
			},
		});
		expect(read.recognised).toBe(true);
		expect(read.errors.fields).toEqual({ name: "name_too_long", titles: "too_many_terms" });
		expect(read.errors.boardRows).toEqual({ 1: "token_invalid" });
		expect(hasErrors(read.errors)).toBe(true);
	});

	it("recognises the search limit", () => {
		const read = readServerFormError({ data: { code: "AUTOMATION_LIMIT_REACHED", limit: 20 } });
		expect(read).toMatchObject({ limitReached: 20, recognised: true });
	});

	it("does not recognise other errors", () => {
		for (const error of [
			null,
			undefined,
			new Error("x"),
			{ data: "text" },
			{ data: { issues: [{ path: ["other"] }] } },
		])
			expect(readServerFormError(error).recognised).toBe(false);
	});
});

describe("draftFromSource", () => {
	it("copies a saved search into a draft", () => {
		const saved = {
			name: "n",
			titles: ["A"],
			skills: [],
			keywords: [],
			locations: ["Nairobi"],
			remote: "remote" as const,
			boards: [{ source: "ashby" as const, token: "acme" }],
			schedule: "weekly" as const,
			aiTopN: 5,
		};
		expect(draftFromSource(saved)).toEqual(saved);
	});
});
