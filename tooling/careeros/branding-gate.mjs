// CAREEROS: P2-C02. Fails CI when a user-visible upstream product name or brand link comes back.
// Plain Node, no dependencies. Usage: node tooling/careeros/branding-gate.mjs [repoRoot]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Case-insensitive. The hyphenated package name `reactive-resume` is only matched inside the upstream URLs below. */
export const PATTERNS = [
	{ name: "Reactive Resume", re: /reactive\s*resume/i },
	{ name: "rxresu.me", re: /rxresu\.me/i },
	{ name: "rxresume", re: /rxresume/i },
	{ name: "rx.cv", re: /(^|[^\w.])rx\.cv\b/i },
	{ name: "upstream GitHub", re: /github\.com\/(reactive-resume|amruthpillai)/i },
	{ name: "GitHub Sponsors", re: /github\.com\/sponsors\//i },
	{ name: "Discord invite", re: /discord\.gg|discord\.com\/invite/i },
	{ name: "Open Collective", re: /opencollective\.com/i },
	{ name: "Crowdin project", re: /crowdin\.com\/project\/reactive-resume/i },
	{ name: "Context7", re: /context7\.com/i },
	{ name: "LinkedIn company page", re: /linkedin\.com\/company\/reactive-resume/i },
	{ name: "upstream author", re: /amruth\s*pillai|amruthpillai|amruth@/i },
	{ name: "OlaCV", re: /olacv|ola\.cv/i },
];

/** Workspace import specifiers and package names are internal and never user-visible. */
const IMPORT_SPECIFIER = /@reactive-resume\//gi;

const ALLOW_MARKER = "careeros-branding-allow:";
const MIN_REASON = 10;
const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".html",
	".css",
	".svg",
	".txt",
	".webmanifest",
	".po",
	".md",
	".mdx",
	".xml",
]);
/** Code files where a line that is only a comment is not user-visible and is not matched. */
const COMMENT_SKIP_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"]);
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const SKIPPED_DIRS = new Set(["node_modules", "tests", ".turbo", "dist", "coverage"]);
const SKIPPED_FILE = /\.(test|spec)\.[^.]+$|^(CHANGELOG.*\.md|LICENSE.*|NOTICE.*)$/i;

/** Roots to scan (relative to the repository). A trailing `/*.po` means only the `.po` files of that directory. */
export const SCAN_ROOTS = [
	"apps/web/src",
	"apps/web/index.html",
	"apps/web/public",
	"apps/web/locales",
	"apps/mobile/app",
	"apps/mobile/src",
	"apps/mobile/locales",
	"apps/mobile/app.config.ts",
	"apps/server/src/static",
	"packages/email/src",
	"packages/pdf/src",
	"packages/ui/src",
];

/**
 * Files that must keep the MIT attribution of the base codebase, so they are allowed by path.
 * A directory entry ends with "/". `LICENSE_SOURCE` below is asserted so the allowance cannot hide a removal.
 */
export const ALLOWED_PATHS = [
	"apps/web/src/routes/_home/licenses.tsx",
	"apps/web/public/third-party-notices.txt",
	"apps/mobile/app/(tabs)/settings/licences.tsx",
	"apps/mobile/src/features/licences/",
];

/** The text of the MIT attribution lives here (checked against NOTICE by its own unit test). */
export const LICENSE_SOURCE = "packages/utils/src/notice.ts";
export const REQUIRED_ATTRIBUTION = ["Reactive Resume", "Copyright (c) 2026 Amruth Pillai"];
/** Both licenses pages must render the notice from that source. */
export const LICENSE_PAGES = ["apps/web/src/routes/_home/licenses.tsx", "apps/mobile/app/(tabs)/settings/licences.tsx"];
export const NOTICE_IMPORT = "@reactive-resume/utils/notice";

function* walk(abs) {
	let stat;
	try {
		stat = statSync(abs);
	} catch {
		return;
	}
	if (stat.isFile()) {
		yield abs;
		return;
	}
	for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) yield* walk(join(abs, entry.name));
		} else if (entry.isFile()) yield join(abs, entry.name);
	}
}

function extensionOf(file) {
	const index = file.lastIndexOf(".");
	return index < 0 ? "" : file.slice(index).toLowerCase();
}

/** Scans one file's text. Pure, so tests can call it directly. Returns findings and the allowances it used. */
export function scanText(file, text) {
	const lines = text.split(/\r?\n/);
	const isPo = file.endsWith(".po");
	const skipComments = COMMENT_SKIP_EXTENSIONS.has(extensionOf(file));
	const findings = [];
	let allowances = 0;
	const allowOf = (line) => {
		const at = line.toLowerCase().indexOf(ALLOW_MARKER);
		return at < 0
			? null
			: line
					.slice(at + ALLOW_MARKER.length)
					.replace(/(\*\/|-->|\}\s*\*\/)\s*$/, "")
					.trim();
	};
	lines.forEach((raw, index) => {
		const number = index + 1;
		const own = allowOf(raw);
		if (own !== null && own.length < MIN_REASON) {
			findings.push({
				file,
				line: number,
				match: `${ALLOW_MARKER} needs a reason of at least ${MIN_REASON} characters`,
			});
		}
		if (isPo && raw.startsWith("#") && own === null) return;
		if (skipComments && COMMENT_LINE.test(raw)) return;
		const line = raw.replace(IMPORT_SPECIFIER, "");
		for (const pattern of PATTERNS) {
			const hit = pattern.re.exec(line);
			if (!hit) continue;
			const previous = index > 0 ? allowOf(lines[index - 1] ?? "") : null;
			const reason = own ?? previous;
			if (reason !== null && reason.length >= MIN_REASON) {
				allowances += 1;
				continue;
			}
			// A short reason is already reported above (same line) or here (line before).
			if (previous !== null && own === null && previous.length < MIN_REASON) {
				findings.push({
					file,
					line: number - 1,
					match: `${ALLOW_MARKER} needs a reason of at least ${MIN_REASON} characters`,
				});
			}
			findings.push({ file, line: number, match: `${hit[0].trim()} (${pattern.name})` });
		}
	});
	return { findings, allowances };
}

function isAllowedPath(rel) {
	return ALLOWED_PATHS.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
}

/** Checks that the licenses pages still render the attribution. Returns error strings. */
export function checkLicenseSources(root) {
	const errors = [];
	const source = join(root, LICENSE_SOURCE);
	if (!existsSync(source)) errors.push(`${LICENSE_SOURCE}: missing; the MIT attribution must stay`);
	else {
		const text = readFileSync(source, "utf8");
		for (const needle of REQUIRED_ATTRIBUTION) {
			if (!text.includes(needle)) errors.push(`${LICENSE_SOURCE}: attribution text "${needle}" is missing`);
		}
	}
	for (const page of LICENSE_PAGES) {
		const abs = join(root, page);
		if (!existsSync(abs)) errors.push(`${page}: licenses page is missing`);
		else if (!readFileSync(abs, "utf8").includes(NOTICE_IMPORT)) {
			errors.push(`${page}: must render the notice from ${NOTICE_IMPORT}`);
		}
	}
	return errors;
}

/** Runs the whole gate on a repository root. */
export function runGate(root) {
	const findings = [];
	let allowances = 0;
	let scanned = 0;
	for (const entry of SCAN_ROOTS) {
		for (const abs of walk(join(root, entry))) {
			const rel = relative(root, abs).split(sep).join("/");
			const name = rel.slice(rel.lastIndexOf("/") + 1);
			if (SKIPPED_FILE.test(name) || !TEXT_EXTENSIONS.has(extensionOf(name)) || isAllowedPath(rel)) continue;
			const result = scanText(rel, readFileSync(abs, "utf8"));
			scanned += 1;
			allowances += result.allowances;
			findings.push(...result.findings);
		}
	}
	return { findings, allowances, scanned, errors: checkLicenseSources(root) };
}

function main() {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
	const { findings, allowances, scanned, errors } = runGate(root);
	for (const f of findings) console.error(`${f.file}:${f.line}: ${f.match}`);
	for (const e of errors) console.error(e);
	console.log(`branding gate: ${scanned} files scanned, ${allowances} allowances used`);
	if (findings.length > 0 || errors.length > 0) {
		console.error(
			`branding gate: FAILED (${findings.length} findings, ${errors.length} errors). See docs/CODING-STANDARDS.md, "Branding gate".`,
		);
		process.exit(1);
	}
	console.log("branding gate: OK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
