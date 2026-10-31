import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { collectRows, parseJunit, renderMarkdown } from "./junit-summary.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
	const root = mkdtempSync(join(tmpdir(), "junit-summary-"));
	roots.push(root);
	return root;
}

function addPackage(root, group, name, { xml, testCi = true } = {}) {
	const directory = join(root, group, name);
	mkdirSync(join(directory, "reports"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: testCi ? { "test:ci": "x" } : {} }));
	if (xml !== undefined) writeFileSync(join(directory, "reports", "vitest-junit.xml"), xml);
}

const normal = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="5" failures="0" errors="0" time="1.25">
  <testsuite name="a.test.ts" tests="5" failures="0" errors="0" skipped="0" time="1.2"></testsuite>
</testsuites>`;
const failing = `<testsuites name="vitest tests" tests="10" failures="2" errors="1" time="3.5"><testsuite name="b" tests="10" skipped="3"></testsuite></testsuites>`;

describe("parseJunit", () => {
	it("parses a normal file", () => {
		expect(parseJunit(normal)).toEqual({ tests: 5, failures: 0, skipped: 0, passed: 5, time: 1.25 });
	});

	it("counts failures, errors and skips", () => {
		expect(parseJunit(`<testsuites tests="10" failures="2" errors="1" skipped="3" time="3.5"></testsuites>`)).toEqual({
			tests: 10,
			failures: 3,
			skipped: 3,
			passed: 4,
			time: 3.5,
		});
	});

	it("falls back to a bare testsuite", () => {
		expect(parseJunit(`<testsuite name="x" tests="2" failures="1" skipped="0" time="0.1"></testsuite>`).passed).toBe(1);
	});

	it("rejects malformed input", () => {
		expect(() => parseJunit("not xml")).toThrow();
		expect(() => parseJunit("<testsuites>")).toThrow();
		expect(() => parseJunit(`<testsuites tests="abc">`)).toThrow();
	});
});

describe("collectRows and renderMarkdown", () => {
	it("reports an empty tree as only a total row", () => {
		const root = makeRoot();
		expect(collectRows(root)).toEqual([]);
		expect(renderMarkdown([])).toContain("**Total**");
	});

	it("summarises packages, failures, no report and malformed files", () => {
		const root = makeRoot();
		addPackage(root, "packages", "good", { xml: normal });
		addPackage(root, "packages", "bad", { xml: failing });
		addPackage(root, "apps", "broken", { xml: "<oops" });
		addPackage(root, "packages", "missing");
		addPackage(root, "packages", "no-script", { testCi: false });
		const rows = collectRows(root);
		expect(rows.map((row) => [row.name, row.status])).toEqual([
			["packages/bad", "ok"],
			["packages/good", "ok"],
			["packages/missing", "no report"],
			["apps/broken", "error"],
		]);
		const markdown = renderMarkdown(rows);
		expect(markdown).toContain("| packages/good | 5 | 5 | 0 | 0 | 1.3s |");
		expect(markdown).toContain("| packages/bad | 10 | 4 | 3 | 3 | 3.5s |");
		expect(markdown).toContain("| packages/missing | no report |");
		expect(markdown).toContain("| apps/broken | error:");
		expect(markdown).toContain("| **Total** | **15** | **9** | **3** | **3** |");
	});
});
