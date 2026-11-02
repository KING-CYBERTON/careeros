import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSkipped, parseTestCases, validateAllowlist } from "./skipped-db-suites.mjs";

// CAREEROS (P2-C03): JUnit fixtures in the shape Vitest writes (<skipped/> inside <testcase>).
function junit(file, cases) {
	const body = cases
		.map(
			({ name, skipped }) =>
				`<testcase classname="${file}" name="${name}" time="0">${skipped ? "\n<skipped/>\n" : ""}</testcase>`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="${cases.length}">\n<testsuite name="${file}" tests="${cases.length}" skipped="0">\n${body}\n</testsuite>\n</testsuites>\n`;
}

function withReports(reports, run) {
	const root = mkdtempSync(join(tmpdir(), "skipped-db-"));
	try {
		for (const [dir, xml] of Object.entries(reports)) {
			mkdirSync(join(root, dir, "reports"), { recursive: true });
			writeFileSync(join(root, dir, "reports", "vitest-junit.xml"), xml);
		}
		return run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("passes when every integration test ran", () => {
	const result = withReports(
		{ "packages/auth": junit("src/a.integration.test.ts", [{ name: "x" }, { name: "y" }]) },
		(root) => checkSkipped(root, []),
	);
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(result.errors, []);
	assert.equal(result.ran, 2);
});

test("fails on a deliberately skipped integration file", () => {
	const result = withReports(
		{ "packages/auth": junit("src/a.integration.test.ts", [{ name: "ran" }, { name: "not run", skipped: true }]) },
		(root) => checkSkipped(root, []),
	);
	assert.deepEqual(result.skipped, [{ file: "packages/auth/src/a.integration.test.ts", name: "not run" }]);
});

test("ignores skipped tests in ordinary test files", () => {
	const result = withReports({ "apps/web": junit("src/a.test.ts", [{ name: "todo", skipped: true }]) }, (root) =>
		checkSkipped(root, []),
	);
	assert.deepEqual(result.skipped, []);
});

test("an allowlisted file with a reason may skip", () => {
	const allowlist = [{ file: "apps/server/src/a.integration.test.ts", reason: "needs a Redis service" }];
	const result = withReports(
		{ "apps/server": junit("src/a.integration.test.ts", [{ name: "x", skipped: true }]) },
		(root) => checkSkipped(root, allowlist),
	);
	assert.deepEqual(result.skipped, []);
	assert.equal(result.allowed, 1);
});

test("an allowlist entry without a real reason is an error", () => {
	assert.equal(validateAllowlist([{ file: "a.integration.test.ts", reason: "short" }]).length, 1);
	assert.equal(validateAllowlist([{ file: "a.integration.test.ts" }]).length, 1);
	assert.equal(validateAllowlist([{ reason: "a long enough reason" }]).length, 1);
	assert.deepEqual(validateAllowlist([{ file: "a.integration.test.ts", reason: "a long enough reason" }]), []);
	const result = withReports({ "packages/auth": junit("src/a.test.ts", [{ name: "x" }]) }, (root) =>
		checkSkipped(root, [{ file: "x", reason: "no" }]),
	);
	assert.equal(result.errors.length, 1);
});

test("the shipped allowlist is valid", async () => {
	const { ALLOWLIST } = await import("./skipped-db-suites.mjs");
	assert.deepEqual(validateAllowlist(ALLOWLIST), []);
});

test("an unreadable report is an error, not a pass", () => {
	const result = withReports({ "packages/auth": "not xml" }, (root) => checkSkipped(root, []));
	assert.equal(result.errors.length, 1);
	assert.throws(() => parseTestCases("<html></html>"));
});

test("reads the testcase file from classname and decodes entities", () => {
	const [testCase] = parseTestCases(junit("src/a.integration.test.ts", [{ name: "a &amp; b", skipped: true }]));
	assert.deepEqual(testCase, { file: "src/a.integration.test.ts", name: "a & b", skipped: true });
});

test("reports are read from apps and packages, and a missing reports directory is fine", () => {
	const result = withReports(
		{
			"apps/server": junit("src/h.integration.test.ts", [{ name: "x", skipped: true }]),
			"packages/db": junit("src/m.integration.test.ts", [{ name: "y" }]),
		},
		(root) => checkSkipped(root, []),
	);
	assert.equal(result.reports, 2);
	assert.equal(result.skipped.length, 1);
	assert.equal(checkSkipped("/nonexistent-root", []).reports, 0);
});
