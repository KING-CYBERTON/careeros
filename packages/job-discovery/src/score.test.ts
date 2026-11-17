import type { NormalizedJob, ScoringProfile } from "./types";
import { describe, expect, it } from "vite-plus/test";
import { locationFit, remoteFit, SCORE_WEIGHTS, scoreBreakdown, scoreJob, termFit, titleFit } from "./score";

type Posting = Pick<NormalizedJob, "title" | "location" | "remote" | "descriptionHtml">;

const profile: ScoringProfile = {
	titles: ["Backend Engineer"],
	skills: ["TypeScript", "PostgreSQL", "Docker"],
	keywords: ["fintech", "payments"],
	locations: ["Nairobi", "Kenya"],
	remote: "hybrid",
};

// Fixed fixtures. The ordering below is pinned: a change to the weights that reorders them must be a decision.
const postings = {
	ideal: {
		title: "Senior Backend Engineer",
		location: "Nairobi, Kenya",
		remote: "hybrid",
		descriptionHtml: "<p>TypeScript, PostgreSQL and Docker for a fintech payments platform.</p>",
	},
	strongRemote: {
		title: "Backend Engineer",
		location: "Remote - Africa",
		remote: "remote",
		descriptionHtml: "<p>TypeScript and PostgreSQL. Payments.</p>",
	},
	relatedTitle: {
		title: "Backend Developer",
		location: "Nairobi",
		remote: "onsite",
		descriptionHtml: "<p>Java and Oracle for a bank.</p>",
	},
	wrongField: {
		title: "Office Manager",
		location: "Berlin",
		remote: "onsite",
		descriptionHtml: "<p>Run the office.</p>",
	},
} satisfies Record<string, Posting>;

describe("scoreJob", () => {
	it("orders the fixtures from the best to the worst match", () => {
		const scores = Object.fromEntries(
			Object.entries(postings).map(([name, posting]) => [name, scoreJob(posting, profile)]),
		);
		expect(scores.ideal).toBeGreaterThan(scores.strongRemote ?? 0);
		expect(scores.strongRemote).toBeGreaterThan(scores.relatedTitle ?? 0);
		expect(scores.relatedTitle).toBeGreaterThan(scores.wrongField ?? 0);
	});

	it("pins the scores of the fixtures", () => {
		expect(scoreJob(postings.ideal, profile)).toBe(100);
		expect(scoreJob(postings.strongRemote, profile)).toBe(77.83);
		expect(scoreJob(postings.relatedTitle, profile)).toBe(33.25);
		expect(scoreJob(postings.wrongField, profile)).toBe(7.5);
	});

	it("keeps every score between 0 and 100", () => {
		for (const posting of Object.values(postings)) {
			const score = scoreJob(posting, profile);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(100);
		}
	});

	it("weights add up to 100", () => {
		expect(Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100);
	});

	it("gives half marks for the preferences left empty, so a bare automation ranks by title", () => {
		const bare: ScoringProfile = {
			titles: ["Backend Engineer"],
			skills: [],
			keywords: [],
			locations: [],
			remote: "any",
		};
		const match = scoreJob({ ...postings.ideal }, bare);
		const miss = scoreJob({ ...postings.wrongField }, bare);
		expect(match).toBeGreaterThan(miss);
		expect(scoreBreakdown(postings.ideal, bare).skills).toBe(SCORE_WEIGHTS.skills / 2);
	});

	it("reads the title and the description case-insensitively and ignores tags", () => {
		const loud: Posting = {
			...postings.ideal,
			title: "SENIOR BACKEND ENGINEER",
			descriptionHtml: "<b>TYPESCRIPT</b>, <i>postgresql</i>",
		};
		expect(scoreBreakdown(loud, profile).title).toBe(SCORE_WEIGHTS.title);
		expect(scoreBreakdown(loud, profile).skills).toBeCloseTo((SCORE_WEIGHTS.skills * 2) / 3, 5);
	});
});

describe("titleFit", () => {
	it("is 1 for the phrase inside the title", () => {
		expect(titleFit("Senior Backend Engineer II", ["backend engineer"])).toBe(1);
	});

	it("is partial for shared words and capped below a phrase match", () => {
		const partial = titleFit("Backend Developer", ["Backend Engineer"]);
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(1);
	});

	it("is 0 when nothing is shared and 0.5 when no title was asked for", () => {
		expect(titleFit("Office Manager", ["Backend Engineer"])).toBe(0);
		expect(titleFit("Office Manager", [])).toBe(0.5);
	});

	it("does not match inside a longer word", () => {
		expect(titleFit("Javascripter", ["Java"])).toBe(0);
	});

	it("takes the best of several wanted titles", () => {
		expect(titleFit("Data Engineer", ["Backend Engineer", "Data Engineer"])).toBe(1);
	});
});

describe("termFit", () => {
	it("matches whole terms only, including ones with symbols", () => {
		expect(termFit("we use c++ and c# and .net daily", ["C++", "C#", ".NET"])).toBe(1);
		expect(termFit("we use javascript", ["java"])).toBe(0);
		expect(termFit("we use go-lang", ["go"])).toBe(1);
	});

	it("is the share of the terms found", () => {
		expect(termFit("react and node", ["react", "node", "rust", "go"])).toBe(0.5);
	});

	it("is half marks for no terms", () => {
		expect(termFit("anything", [])).toBe(0.5);
	});

	it("is safe against regular expression characters in a term", () => {
		expect(termFit("a (b) [c] *", ["(b)", "[c]", "*", "(", "a.*"])).toBeGreaterThanOrEqual(0);
	});
});

describe("remote and location fit", () => {
	it("any preference accepts everything", () => {
		for (const kind of ["remote", "hybrid", "onsite", null] as const) expect(remoteFit("any", kind)).toBe(1);
	});

	it("a remote preference ranks remote over hybrid over on-site", () => {
		expect(remoteFit("remote", "remote")).toBeGreaterThan(remoteFit("remote", "hybrid"));
		expect(remoteFit("remote", "hybrid")).toBeGreaterThan(remoteFit("remote", "onsite"));
	});

	it("an on-site preference ranks on-site over hybrid over remote", () => {
		expect(remoteFit("onsite", "onsite")).toBeGreaterThan(remoteFit("onsite", "hybrid"));
		expect(remoteFit("onsite", "hybrid")).toBeGreaterThan(remoteFit("onsite", "remote"));
	});

	it("a wanted place in the location is a full fit, a remote role fits any place, an unknown place is doubtful", () => {
		expect(locationFit(["Nairobi"], "Nairobi, Kenya", "onsite")).toBe(1);
		expect(locationFit(["Nairobi"], "Berlin", "onsite")).toBe(0);
		expect(locationFit(["Nairobi"], "Berlin", "remote")).toBeGreaterThan(0);
		expect(locationFit(["Nairobi"], null, null)).toBe(0.3);
		expect(locationFit([], "Berlin", "onsite")).toBe(1);
	});
});
