// CAREEROS: P2-C03. Fails CI when a database integration suite is silently skipped.
// Reads the JUnit reports that `test:ci` writes to <package>/reports/vitest-junit.xml and fails if any test case in a
// file matching *.integration.test.ts is skipped, unless the file is on ALLOWLIST with a reason.
// Plain Node, no dependencies. Usage: node tooling/careeros/skipped-db-suites.mjs [repoRoot]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration files that may skip in CI. Each entry: { file: "<repo-relative path>", reason: "<why, at least 10 chars>" }.
 * Empty on purpose: every suite runs against the Postgres service in the unit job. Add an entry only for a suite that
 * truly needs a service CI does not have, and log a question in docs/questions.md for it.
 */
export const ALLOWLIST = [];

export const MIN_REASON_LENGTH = 10;
const INTEGRATION_FILE = /\.integration\.test\.tsx?$/;
const GROUPS = ["packages", "apps"];

function decode(text) {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function readAttributes(tag) {
	const attributes = {};
	for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attributes[match[1]] = decode(match[2] ?? match[3] ?? "");
	}
	return attributes;
}

/** Returns every <testcase> of a JUnit document as { file, name, skipped }. Throws on text that is not JUnit. */
export function parseTestCases(xml) {
	if (typeof xml !== "string") throw new Error("report is not text");
	const body = xml.replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
	if (!/<testsuites?(?=[\s>/])/.test(body)) throw new Error("no <testsuites> or <testsuite> element");
	const cases = [];
	for (const suite of body.matchAll(/<testsuite(?=[\s>/])([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g)) {
		const suiteAttributes = readAttributes(suite[1] ?? "");
		const inner = suite[3] ?? "";
		for (const found of inner.matchAll(/<testcase(?=[\s>/])([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
			const attributes = readAttributes(found[1] ?? "");
			cases.push({
				file: attributes.classname ?? suiteAttributes.name ?? "",
				name: attributes.name ?? "",
				skipped: /<skipped(?=[\s>/])/.test(found[3] ?? ""),
			});
		}
	}
	return cases;
}

export function validateAllowlist(allowlist) {
	const errors = [];
	for (const [index, entry] of allowlist.entries()) {
		if (!entry || typeof entry.file !== "string" || entry.file === "") {
			errors.push(`allowlist entry ${index} has no file`);
		} else if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON_LENGTH) {
			errors.push(`allowlist entry ${entry.file} needs a reason of at least ${MIN_REASON_LENGTH} characters`);
		}
	}
	return errors;
}

function reportFiles(root) {
	const found = [];
	for (const group of GROUPS) {
		const groupDirectory = join(root, group);
		if (!existsSync(groupDirectory)) continue;
		for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const reports = join(groupDirectory, entry.name, "reports");
			if (!existsSync(reports) || !statSync(reports).isDirectory()) continue;
			for (const file of readdirSync(reports)) {
				if (file.endsWith(".xml")) found.push({ path: join(reports, file), directory: `${group}/${entry.name}` });
			}
		}
	}
	return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Scans the reports under `root`. Returns { skipped, errors, reports, ran, allowed }:
 * `skipped` lists skipped cases in integration files that are not allowlisted, `ran` counts integration test cases that
 * ran (not skipped), `allowed` counts skipped cases excused by the allowlist.
 */
export function checkSkipped(root, allowlist = ALLOWLIST) {
	const errors = validateAllowlist(allowlist);
	const allowed = new Set(allowlist.map((entry) => entry?.file));
	const skipped = [];
	let reports = 0;
	let ran = 0;
	let allowedCount = 0;
	for (const report of reportFiles(root)) {
		let cases;
		try {
			cases = parseTestCases(readFileSync(report.path, "utf8"));
		} catch (error) {
			errors.push(`${report.path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		reports += 1;
		for (const testCase of cases) {
			if (!INTEGRATION_FILE.test(testCase.file)) continue;
			const file = `${report.directory}/${testCase.file}`;
			if (!testCase.skipped) {
				ran += 1;
			} else if (allowed.has(file)) {
				allowedCount += 1;
			} else {
				skipped.push({ file, name: testCase.name });
			}
		}
	}
	return { skipped, errors, reports, ran, allowed: allowedCount };
}

function main() {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
	const { skipped, errors, reports, ran, allowed } = checkSkipped(root);
	for (const item of skipped) console.error(`SKIPPED ${item.file}: ${item.name}`);
	for (const message of errors) console.error(message);
	console.log(
		`skipped-db-suites: ${reports} reports read, ${ran} integration tests ran, ${skipped.length} skipped, ${allowed} allowed`,
	);
	if (skipped.length > 0 || errors.length > 0) {
		console.error(
			'skipped-db-suites: FAILED. A database integration suite did not run. See docs/CODING-STANDARDS.md, "Database suites must run in CI".',
		);
		process.exit(1);
	}
	console.log("skipped-db-suites: OK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
