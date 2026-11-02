// CAREEROS (P5-T01): zips apps/extension/dist as job-clipper-<version>.zip, the file the stores take. Run after the
// build (`pnpm --filter extension pack` does both). Refuses a build that is not a production build.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

if (manifest.version !== version)
	throw new Error(`dist/manifest.json is ${manifest.version}, package.json is ${version}; rebuild.`);
if (manifest.optional_host_permissions?.some((pattern) => pattern.startsWith("http:")))
	throw new Error(
		"dist is a development build (it lists http hosts); build without --mode development before packing.",
	);

const files = {};
const walk = (directory) => {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) walk(path);
		else files[relative(dist, path).split(sep).join("/")] = new Uint8Array(readFileSync(path));
	}
};
walk(dist);

const archive = join(root, `job-clipper-${version}.zip`);
// A fixed timestamp keeps the same build byte-for-byte the same archive.
writeFileSync(archive, zipSync(files, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }));
console.log(`${archive} (${Object.keys(files).length} files)`);
