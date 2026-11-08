// CAREEROS (P5-C01): the checks a clipper zip must pass before it goes anywhere. Pure functions over the zip's entries,
// so the pack script runs them on the real archive and the tests run them on bad fixtures.
// @boundaries-ignore the branding gate is repository tooling; its word list is the one source of truth
import { PATTERNS } from "../../../tooling/careeros/branding-gate.mjs";

/** The manifest permissions. src/manifest.test.ts asserts the same set; src/pack-checks.test.mjs ties the two together. */
export const EXPECTED_PERMISSIONS = ["activeTab", "scripting", "storage"];

/** The largest zip the pack accepts (spec P5-C01). */
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;

/** Chrome's version format: one to four dot-separated integers of 0 to 65535, no leading zeros. */
export function isChromeVersion(value) {
	if (typeof value !== "string") return false;
	const parts = value.split(".");
	if (parts.length > 4) return false;
	return parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535);
}

const FORBIDDEN_PATH = [
	{ name: "source map", test: (path) => /\.map$/i.test(path) },
	{ name: ".env file", test: (path) => path.split("/").some((part) => /^\.env/i.test(part)) },
	{ name: "node_modules folder", test: (path) => path.split("/").includes("node_modules") },
	{
		name: "test file",
		test: (path) => /\.(test|spec)\.[^./]+$/i.test(path) || path.split("/").some((part) => /^__tests__$/i.test(part)),
	},
];

const TEXT_FILE = /\.(js|mjs|cjs|json|html|css|svg|txt)$/i;

/**
 * @param {{ entries: Record<string, Uint8Array>, zipBytes: number, packageVersion: string }} input
 * @returns {string[]} one message per problem; empty when the archive is fit to submit
 */
export function checkArchive({ entries, zipBytes, packageVersion }) {
	const problems = [];
	const names = Object.keys(entries);

	if (zipBytes > MAX_ZIP_BYTES) problems.push(`zip is ${zipBytes} bytes; the limit is ${MAX_ZIP_BYTES}`);

	for (const name of names) {
		for (const rule of FORBIDDEN_PATH) {
			if (rule.test(name)) problems.push(`zip holds a ${rule.name}: ${name}`);
		}
	}

	const manifestBytes = entries["manifest.json"];
	if (!manifestBytes) {
		problems.push("manifest.json is not at the root of the zip");
	} else {
		let manifest;
		try {
			manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
		} catch {
			problems.push("manifest.json is not valid JSON");
		}
		if (manifest) {
			const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions].sort() : [];
			const expected = [...EXPECTED_PERMISSIONS].sort();
			if (JSON.stringify(permissions) !== JSON.stringify(expected))
				problems.push(
					`manifest permissions are [${permissions.join(", ")}]; expected exactly [${expected.join(", ")}]`,
				);
			if (manifest.version !== packageVersion)
				problems.push(`manifest version is ${manifest.version}; package.json is ${packageVersion}`);
			if (!isChromeVersion(manifest.version))
				problems.push(`manifest version ${manifest.version} is not Chrome's dotted-number format`);
			if (!isChromeVersion(packageVersion))
				problems.push(`package.json version ${packageVersion} is not Chrome's dotted-number format (no suffix)`);
		}
	}

	// Product branding: the word list of tooling/careeros/branding-gate.mjs, over every text file in the zip. A bundle is
	// one long line, so the gate's skip of comment-only lines does not apply here.
	const decoder = new TextDecoder();
	for (const name of names) {
		if (!TEXT_FILE.test(name)) continue;
		const text = decoder.decode(entries[name]);
		for (const pattern of PATTERNS) {
			if (pattern.re.test(text)) problems.push(`${name} contains product branding (${pattern.name})`);
		}
	}

	return problems;
}
