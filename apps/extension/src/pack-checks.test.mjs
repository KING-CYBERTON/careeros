// CAREEROS (P5-C01): the pack checks pass a good archive and fail each deliberately bad fixture.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { unzipSync, zipSync } from "fflate";
import { checkArchive, EXPECTED_PERMISSIONS, isChromeVersion, MAX_ZIP_BYTES } from "../scripts/pack-checks.mjs";
import { buildManifest } from "./manifest";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const encode = (text) => new TextEncoder().encode(text);

const goodManifest = () => ({ ...buildManifest({ version }) });
const entriesFor = (manifest, extra = {}) => ({
	"manifest.json": encode(JSON.stringify(manifest)),
	"popup.html": encode("<!doctype html><title>Job Clipper</title>"),
	"service-worker.js": encode(""),
	...extra,
});
// Builds a real zip and reads it back, as pack.mjs does.
const run = (entries, overrides = {}) => {
	const bytes = zipSync(entries);
	return checkArchive({
		entries: unzipSync(bytes),
		zipBytes: bytes.length,
		packageVersion: version,
		...overrides,
	});
};

describe("pack checks", () => {
	it("pass a good archive", () => {
		expect(run(entriesFor(goodManifest()))).toEqual([]);
	});

	it("expect the same permissions as the production manifest", () => {
		expect([...EXPECTED_PERMISSIONS].sort()).toEqual([...buildManifest({ version }).permissions].sort());
	});

	it("fail a source map", () => {
		const problems = run(entriesFor(goodManifest(), { "assets/popup.js.map": encode("{}") }));
		expect(problems).toEqual(["zip holds a source map: assets/popup.js.map"]);
	});

	it("fail .env files, node_modules and test files", () => {
		const problems = run(
			entriesFor(goodManifest(), {
				".env.local": encode("A=1"),
				"assets/.env": encode("A=1"),
				"node_modules/x/index.js": encode(""),
				"assets/popup.test.js": encode(""),
				"__tests__/a.js": encode(""),
			}),
		);
		expect(problems).toHaveLength(5);
		expect(problems.join("\n")).toContain(".env file: .env.local");
		expect(problems.join("\n")).toContain("node_modules folder");
		expect(problems.join("\n")).toContain("test file: assets/popup.test.js");
	});

	it("fail an extra permission", () => {
		const manifest = { ...goodManifest(), permissions: [...EXPECTED_PERMISSIONS, "tabs"] };
		const problems = run(entriesFor(manifest));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("expected exactly [activeTab, scripting, storage]");
	});

	it("fail a missing permission", () => {
		const manifest = { ...goodManifest(), permissions: ["storage"] };
		expect(run(entriesFor(manifest))).toHaveLength(1);
	});

	it("fail a manifest version that differs from package.json", () => {
		const manifest = { ...goodManifest(), version: "9.9.9" };
		const problems = run(entriesFor(manifest));
		expect(problems).toEqual([`manifest version is 9.9.9; package.json is ${version}`]);
	});

	it("fail a version that is not Chrome's format, even when the two agree", () => {
		const problems = run(entriesFor({ ...goodManifest(), version: "1.0.0-beta.1" }), {
			packageVersion: "1.0.0-beta.1",
		});
		expect(problems).toHaveLength(2);
		expect(problems.join("\n")).toContain("dotted-number format");
	});

	it("fail a manifest that is not at the root", () => {
		const problems = run({ "extension/manifest.json": encode(JSON.stringify(goodManifest())) });
		expect(problems).toEqual(["manifest.json is not at the root of the zip"]);
	});

	it("fail a manifest that is not JSON", () => {
		expect(run({ "manifest.json": encode("{") })).toEqual(["manifest.json is not valid JSON"]);
	});

	it("fail a zip over 10 MB", () => {
		const problems = run(entriesFor(goodManifest()), { zipBytes: MAX_ZIP_BYTES + 1 });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("the limit is 10485760");
	});

	it("fail product branding in any text file", () => {
		const problems = run(entriesFor(goodManifest(), { "assets/popup.js": encode('const a="Reactive Resume";') }));
		expect(problems).toEqual(["assets/popup.js contains product branding (Reactive Resume)"]);
	});

	it("ignore branding words inside binary files", () => {
		expect(run(entriesFor(goodManifest(), { "icons/icon-16.png": encode("rxresume") }))).toEqual([]);
	});
});

describe("isChromeVersion", () => {
	it("accepts one to four integers of 0 to 65535", () => {
		for (const ok of ["1", "0.1.0", "1.2.3.4", "65535.0.0.1"]) expect(isChromeVersion(ok)).toBe(true);
	});

	it("rejects suffixes, leading zeros, extra parts and big numbers", () => {
		for (const bad of ["", "1.0.0-rc.1", "01.0", "1.2.3.4.5", "65536.0", "1..2", "v1.0"])
			expect(isChromeVersion(bad)).toBe(false);
	});
});
