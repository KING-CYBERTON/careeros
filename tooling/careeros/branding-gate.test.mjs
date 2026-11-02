import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LICENSE_PAGES, LICENSE_SOURCE, runGate } from "./branding-gate.mjs";

// CAREEROS (P2-C02): fixtures in a temp directory; each test builds the smallest tree the gate accepts.
const NOTICE_TS = 'export const x = "Reactive Resume (base codebase)\\nCopyright (c) 2026 Amruth Pillai";\n';
const PAGE = 'import { NOTICE_ENTRIES } from "@reactive-resume/utils/notice";\n';

function fixture(files = {}) {
	const root = mkdtempSync(join(tmpdir(), "branding-gate-"));
	const all = {
		[LICENSE_SOURCE]: NOTICE_TS,
		...Object.fromEntries(LICENSE_PAGES.map((page) => [page, PAGE])),
		...files,
	};
	for (const [file, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	return root;
}

function run(files) {
	const root = fixture(files);
	try {
		return runGate(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a clean tree passes", () => {
	const result = run({ "apps/web/src/a.tsx": "export const a = 1;\n" });
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.errors, []);
});

test("a forbidden string in a tsx file is caught with file and line", () => {
	const result = run({ "apps/web/src/a.tsx": "const a = 1;\nexport const b = <p>Built with Reactive Resume</p>;\n" });
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0].file, "apps/web/src/a.tsx");
	assert.equal(result.findings[0].line, 2);
});

test("upstream links are caught", () => {
	const result = run({
		"apps/mobile/src/a.ts":
			'export const u = "https://discord.gg/abc";\nexport const v = "https://opencollective.com/x";\n',
	});
	assert.equal(result.findings.length, 2);
});

test("an @reactive-resume/ui import passes", () => {
	const result = run({ "apps/web/src/a.tsx": 'import { Button } from "@reactive-resume/ui/components/button";\n' });
	assert.deepEqual(result.findings, []);
});

test("a .po msgstr is caught, and reference comments are not", () => {
	const result = run({
		"apps/web/locales/de-DE.po":
			'#: ../src/reactive-resume.tsx\nmsgid "Hello"\nmsgstr "Willkommen bei Reactive Resume"\n',
	});
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0].line, 3);
});

test("test files and comment-only lines are not matched", () => {
	const result = run({
		"apps/web/src/a.test.ts": 'export const a = "Reactive Resume";\n',
		"apps/web/src/b.ts": "// Reactive Resume used to be here\nexport const b = 1;\n",
	});
	assert.deepEqual(result.findings, []);
});

test("an allow comment with a reason passes and is counted", () => {
	const result = run({
		"apps/web/src/a.ts":
			"// careeros-branding-allow: importer for the upstream file format\nexport const a = parseReactiveResume;\n",
		"apps/web/src/b.ts": "export const b = parseReactiveResume; // careeros-branding-allow: importer name, not shown\n",
	});
	assert.deepEqual(result.findings, []);
	assert.equal(result.allowances, 2);
});

test("an allow comment without a reason fails", () => {
	const result = run({
		"apps/web/src/a.ts": "// careeros-branding-allow: ok\nexport const a = parseReactiveResume;\n",
	});
	assert.ok(result.findings.length >= 1);
	assert.ok(result.findings.some((f) => f.match.includes("needs a reason")));
	assert.equal(result.allowances, 0);
});

test("the licenses page without the attribution fails", () => {
	const result = run({ [LICENSE_SOURCE]: "export const x = 1;\n" });
	assert.ok(result.errors.some((e) => e.includes("attribution text")));
});

test("a licenses page that no longer renders the notice fails", () => {
	const result = run({ [LICENSE_PAGES[0]]: "export const page = 1;\n" });
	assert.ok(result.errors.some((e) => e.includes("must render the notice")));
});

test("the licenses page is allowed to name the base codebase", () => {
	const result = run({ [LICENSE_PAGES[0]]: `${PAGE}export const t = "Reactive Resume";\n` });
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.errors, []);
});
