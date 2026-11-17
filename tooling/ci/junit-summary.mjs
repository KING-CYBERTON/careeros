// CAREEROS: P1-C02. Per-package JUnit summary for the CI run page. Node built-ins only.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const GROUPS = ["packages", "apps"];

function readAttributes(tag) {
	const attributes = {};
	for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attributes[match[1]] = match[2] ?? match[3] ?? "";
	}
	return attributes;
}

function toCount(value, name) {
	if (value === undefined) return 0;
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new Error(`invalid ${name} attribute: ${value}`);
	return number;
}

/**
 * Reads the totals from the root element of a JUnit file: <testsuites> when present,
 * otherwise the first <testsuite>. Throws on anything that is not recognisable JUnit.
 */
export function parseJunit(xml) {
	if (typeof xml !== "string") throw new Error("report is not text");
	const body = xml.replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
	const root = /<testsuites(?=[\s>/])([^>]*)>/.exec(body) ?? /<testsuite(?=[\s>/])([^>]*)>/.exec(body);
	if (!root) throw new Error("no <testsuites> or <testsuite> element");
	const attributes = readAttributes(root[1] ?? "");
	if (attributes.tests === undefined) throw new Error("root element has no tests attribute");
	const tests = toCount(attributes.tests, "tests");
	const failures = toCount(attributes.failures, "failures") + toCount(attributes.errors, "errors");
	// Vitest omits `skipped` on <testsuites>, so fall back to summing the child <testsuite> elements.
	let skipped = toCount(attributes.skipped, "skipped");
	if (attributes.skipped === undefined) {
		skipped = 0;
		for (const suite of body.matchAll(/<testsuite(?=[\s>/])([^>]*)>/g)) {
			skipped += toCount(readAttributes(suite[1] ?? "").skipped, "skipped");
		}
	}
	const time = attributes.time === undefined ? 0 : toCount(attributes.time, "time");
	return { tests, failures, skipped, passed: Math.max(0, tests - failures - skipped), time };
}

function findXmlFiles(directory) {
	if (!existsSync(directory)) return [];
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findXmlFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".xml")) files.push(path);
	}
	return files.sort();
}

function hasTestCi(directory) {
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		return Boolean(manifest.scripts?.["test:ci"]);
	} catch {
		return false;
	}
}

/** Returns one row per workspace package under packages/* and apps/* that has a test:ci script or a report. */
export function collectRows(root) {
	const rows = [];
	for (const group of GROUPS) {
		const groupDirectory = join(root, group);
		if (!existsSync(groupDirectory)) continue;
		for (const entry of readdirSync(groupDirectory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.isDirectory()) continue;
			const directory = join(groupDirectory, entry.name);
			const name = `${group}/${entry.name}`;
			const files = findXmlFiles(join(directory, "reports"));
			if (files.length === 0) {
				if (hasTestCi(directory)) rows.push({ name, status: "no report" });
				continue;
			}
			const total = { tests: 0, passed: 0, failures: 0, skipped: 0, time: 0 };
			const errors = [];
			for (const file of files) {
				try {
					const result = parseJunit(readFileSync(file, "utf8"));
					for (const key of Object.keys(total)) total[key] += result[key] ?? 0;
				} catch (error) {
					errors.push(`${relative(directory, file)}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (errors.length > 0) rows.push({ name, status: "error", detail: errors.join("; "), ...total });
			else rows.push({ name, status: "ok", ...total });
		}
	}
	return rows;
}

const escapeCell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
const seconds = (value) => `${value.toFixed(1)}s`;

export function renderMarkdown(rows) {
	const lines = [
		"### Unit test summary",
		"",
		"| Package | Tests | Passed | Failed | Skipped | Time |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
	];
	const total = { tests: 0, passed: 0, failures: 0, skipped: 0, time: 0 };
	for (const row of rows) {
		if (row.status === "no report") {
			lines.push(`| ${escapeCell(row.name)} | no report | | | | |`);
			continue;
		}
		if (row.status === "error") {
			lines.push(`| ${escapeCell(row.name)} | error: ${escapeCell(row.detail)} | | | | |`);
		} else {
			lines.push(
				`| ${escapeCell(row.name)} | ${row.tests} | ${row.passed} | ${row.failures} | ${row.skipped} | ${seconds(row.time)} |`,
			);
		}
		for (const key of Object.keys(total)) total[key] += row[key] ?? 0;
	}
	lines.push(
		`| **Total** | **${total.tests}** | **${total.passed}** | **${total.failures}** | **${total.skipped}** | **${seconds(total.time)}** |`,
	);
	return `${lines.join("\n")}\n`;
}

export function main(root = process.cwd(), summaryPath = process.env.GITHUB_STEP_SUMMARY) {
	try {
		const markdown = renderMarkdown(collectRows(root));
		if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
		else process.stdout.write(markdown);
	} catch (error) {
		// Never fail the CI job because of the summary.
		console.error(`junit-summary: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && statSync(process.argv[1]).isFile()) {
	main();
}
