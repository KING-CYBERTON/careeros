// CAREEROS: checks the static landing pages in apps/web/public/landing before they are deployed. The server sends
// every .html file with a content security policy that allows scripts and stylesheets from this site only, so a page
// with an inline script or a stylesheet from another host would load broken. The check also follows every local link.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Addresses outside the landing folder that the pages may link to. The app serves all of them.
export const APP_PATHS = new Set(["/favicon.svg", "/auth/register", "/auth/login"]);

function attributes(html, name) {
	return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((match) => match[1]);
}

/** Returns the problems found in one page. `read` returns a sibling file's text, or null when it does not exist. */
export function checkPage(name, html, read) {
	const problems = [];
	const report = (message) => problems.push(`${name}: ${message}`);
	const ids = (text) => new Set(attributes(text, "id"));

	if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) report("inline <script> is blocked by the content security policy");
	if (/\son[a-z]+="/i.test(html)) report("inline event handler is blocked by the content security policy");
	if (!/<title>[^<]+<\/title>/.test(html)) report("missing <title>");

	for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
		const address = /\s(?:src|href)="([^"]*)"/.exec(tag[0])?.[1];
		if (address && /^(?:https?:)?\/\//.test(address)) report(`${tag[1]} loads from another host: ${address}`);
	}

	for (const address of [...attributes(html, "href"), ...attributes(html, "src")]) {
		if (address.startsWith("mailto:")) continue;
		if (/^(?:https?:)?\/\//.test(address)) continue;
		const [path, anchor] = address.split("#");
		const file = path.split("?")[0];
		if (file.startsWith("/")) {
			if (!APP_PATHS.has(file)) report(`link to an address the check does not know: ${address}`);
			continue;
		}
		let target = html;
		if (file !== "") {
			target = read(file);
			if (target === null) {
				report(`missing file: ${file}`);
				continue;
			}
		}
		if (anchor && (file === "" || file.endsWith(".html")) && !ids(target).has(anchor)) {
			report(`no element with id "${anchor}" for ${address}`);
		}
	}
	return problems;
}

/** Checks every .html file in a folder. */
export function checkFolder(folder) {
	const read = (file) => {
		const path = resolve(folder, file);
		if (!path.startsWith(resolve(folder)) || !existsSync(path)) return null;
		return /\.(?:html|css|js|svg|txt)$/.test(path) ? readFileSync(path, "utf8") : "";
	};
	const pages = readdirSync(folder).filter((file) => file.endsWith(".html"));
	if (!pages.includes("index.html")) return [`${folder}: index.html is missing`];
	return pages.flatMap((page) => checkPage(page, readFileSync(join(folder, page), "utf8"), read));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const problems = checkFolder(join(root, "apps", "web", "public", "landing"));
	for (const problem of problems) console.error(`::error::${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log("Landing pages: no problems found.");
}
