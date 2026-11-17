// CAREEROS: P0-C04 deny-list check for `pnpm licenses list --prod -r --json` output.
// Usage: node check-licenses.mjs <report.json>
// Output shape: { "<license string>": [{ name, versions, license, ... }] }
import { readFileSync } from "node:fs";

const DENY = /^(GPL-2\.0|GPL-3\.0|AGPL-3\.0|SSPL-1\.0)(-only|-or-later|\+)?$/;
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));

const isDenied = (t) => DENY.test(t.trim());
const clean = (expr) => expr.replace(/[()]/g, " ");

// An SPDX expression is a violation only when every OR-alternative contains a denied id.
function violates(expr) {
	return clean(expr)
		.split(/\s+OR\s+/)
		.every((alt) => alt.split(/\s+(?:AND|WITH)\s+/).some(isDenied));
}
const mentionsDenied = (expr) =>
	clean(expr)
		.split(/\s+(?:OR|AND|WITH)\s+/)
		.some(isDenied);

let violations = 0;
for (const [expr, pkgs] of Object.entries(report)) {
	if (!mentionsDenied(expr)) continue;
	const list = pkgs.map((p) => `${p.name}@${(p.versions ?? []).join(",")}`).join(", ");
	if (violates(expr)) {
		violations += pkgs.length;
		console.log(`::warning title=Deny-listed license::${expr}: ${list}`);
	} else {
		console.log(`NOTE dual-licensed with a permitted alternative (${expr}): ${list}`);
	}
}

if (violations > 0) {
	console.log(`Found ${violations} production package(s) under a deny-listed license.`);
	process.exit(1);
}
console.log("No deny-listed production licenses found.");
