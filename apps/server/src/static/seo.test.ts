import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "https://rxresu.me/" } }));
vi.mock("@reactive-resume/api/features/resume/web-page", () => ({
	listIndexableResumes: async () => [
		{ username: "tess", slug: "game-dev", isPrimary: true, updatedAt: new Date("2026-10-01T00:00:00Z") },
		{ username: "tess", slug: "level-design", isPrimary: false, updatedAt: new Date("2026-10-02T00:00:00Z") },
	],
}));

const { handlePagesSitemap, handleResumesSitemap, handleLlms } = await import("./seo");

it("lists each indexed resume at its canonical address: the primary at /<username>", async () => {
	const xml = await (await handleResumesSitemap(1)).text();
	expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual([
		"https://rxresu.me/tess",
		"https://rxresu.me/tess/level-design",
	]);
});

it("publishes a neutral llms.txt with the platform name and no upstream links", async () => {
	const text = await handleLlms().text();
	// The test deployment itself lives at an upstream-looking address; only the copy is checked.
	const copy = text.replaceAll("https://rxresu.me", "");
	expect(text).toMatch(/^# CareerOS\n\n> CareerOS is a career workspace/);
	expect(text).toContain("/licenses");
	expect(copy).not.toMatch(/reactive resume|rxresu|context7|opencollective|discord|crowdin|amruth/i);
	expect((await handleLlms("Acme Careers").text()).startsWith("# Acme Careers\n")).toBe(true);
});

describe("localized sitemap", () => {
	it("gives every localized public page its own entry with reciprocal alternates", async () => {
		const response = handlePagesSitemap();
		const xml = await response.text();
		const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => ({
			loc: match[1]?.match(/<loc>(.*?)<\/loc>/)?.[1],
			alternates: [...(match[1] ?? "").matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((link) => ({
				language: link[1],
				href: link[2],
			})),
		}));
		const locations = entries.map((entry) => entry.loc);

		expect(response.headers.get("Content-Type")).toBe("application/xml; charset=UTF-8");
		// Two localized public pages, 54 real locales (x-default shares English's URL), and the two marketing pages.
		expect(entries).toHaveLength(110);
		for (const path of ["/", "/organisations"]) {
			const entry = entries.filter((candidate) => candidate.loc === `https://rxresu.me${path}`);
			expect(entry).toHaveLength(1);
			expect(entry[0]?.alternates).toEqual([]);
		}
		expect(new Set(locations).size).toBe(entries.length);
		for (const path of ["/ats-checker", "/resume-templates"]) {
			const base = `https://rxresu.me${path}`;
			expect(locations).toContain(base);
			expect(locations).toContain(`${base}?locale=de-DE`);
			expect(locations).toContain(`${base}?locale=ar-SA`);
			expect(locations).toContain(`${base}?locale=en-GB`);
			const group = entries.filter((entry) => entry.loc?.split("?")[0] === base);
			expect(group).toHaveLength(54);
			for (const entry of group) {
				expect(entry.alternates).toHaveLength(55);
				expect(entry.alternates).toEqual(group[0]?.alternates);
				expect(entry.alternates).toContainEqual({ language: "x-default", href: base });
				expect(entry.alternates).toContainEqual({ language: "sr", href: `${base}?locale=sr-SP` });
				for (const alternate of entry.alternates) expect(locations).toContain(alternate.href);
			}
		}
		expect(xml).not.toContain("zu-ZA");
		expect(xml).not.toContain("/dashboard");
	});
});
