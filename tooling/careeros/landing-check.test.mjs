import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFolder, checkPage } from "./landing-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = (body) => `<!doctype html><title>t</title>${body}`;
const none = () => null;

test("the landing pages in the repository pass", () => {
	assert.deepEqual(checkFolder(join(root, "apps", "web", "public", "site")), []);
});

test("rejects what the content security policy blocks", () => {
	assert.match(checkPage("a.html", page("<script>alert(1)</script>"), none)[0], /inline <script>/);
	assert.match(checkPage("a.html", page('<a href="#x" onclick="go()">x</a><p id="x"></p>'), none)[0], /event handler/);
	assert.match(
		checkPage("a.html", page('<link href="https://fonts.example/x.css" rel="stylesheet">'), none)[0],
		/another host/,
	);
});

test("follows local links and anchors", () => {
	const read = (file) => (file === "b.html" ? '<h2 id="pricing">p</h2>' : null);
	assert.deepEqual(checkPage("a.html", page('<a href="b.html#pricing">p</a><script src="b.html"></script>'), read), []);
	assert.match(checkPage("a.html", page('<a href="b.html#missing">p</a>'), read)[0], /no element with id "missing"/);
	assert.match(checkPage("a.html", page('<a href="c.html">c</a>'), read)[0], /missing file: c.html/);
	assert.match(checkPage("a.html", page('<a href="#nowhere">c</a>'), read)[0], /no element with id "nowhere"/);
	assert.match(checkPage("a.html", page('<a href="/dashboard">c</a>'), read)[0], /does not know/);
	assert.deepEqual(
		checkPage("a.html", page('<a href="/auth/register">c</a><a href="mailto:a@b.example">m</a>'), read),
		[],
	);
});

test("pages link to each other by address, never by file name", () => {
	const read = (file) => (file === "organisations.html" ? '<h2 id="pricing">p</h2>' : file === "x.css" ? "" : null);
	assert.deepEqual(
		checkPage("a.html", page('<a href="/organisations#pricing">p</a><link rel="stylesheet" href="/site/x.css">'), read),
		[],
	);
	assert.match(checkPage("a.html", page('<a href="/organisations#nope">p</a>'), read)[0], /no element with id "nope"/);
	assert.match(checkPage("a.html", page('<a href="organisations.html">p</a>'), read)[0], /shows a file name/);
	const home = (file) => (file === "index.html" ? '<h2 id="builder">b</h2>' : null);
	assert.deepEqual(checkPage("a.html", page('<a href="/#builder">b</a><a href="/">home</a>'), home), []);
	assert.deepEqual(checkPage("a.html", page('<script type="application/ld+json">{}</script>'), home), []);
	assert.match(
		checkPage("a.html", page('<link rel="stylesheet" href="/site/gone.css">'), read)[0],
		/missing file: gone.css/,
	);
});

test("a page needs a title", () => {
	assert.match(checkPage("a.html", "<!doctype html><p>x</p>", none)[0], /missing <title>/);
});
