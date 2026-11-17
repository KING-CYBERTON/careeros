// CAREEROS (P5-T04): the Write email sheet's "Open in mail app" and "Copy" actions, and the built-in text twin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { transformSync } = createRequire(serverRequire.resolve("tsx"))("esbuild");

function load(url, dependencies = {}) {
	const module = { exports: {} };
	const code = transformSync(readFileSync(url, "utf8"), { loader: "ts", format: "cjs" }).code;
	new Function("require", "module", "exports", code)(
		(name) => {
			assert.ok(name in dependencies, `Missing boundary: ${name}`);
			return dependencies[name];
		},
		module,
		module.exports,
	);
	return module.exports;
}

// The real link builder from the shared package, so the length rule under test is the one the web uses.
const mailto = load(new URL("../../../packages/email-templates/src/mailto.ts", import.meta.url));
const { openInMailApp, copyEmail } = load(new URL("../src/features/email-templates/actions.ts", import.meta.url), {
	"@careeros/email-templates": mailto,
});

const email = { to: "sam@acme.test", subject: "Thank you & more", body: "Hello Sam,\nThanks for your time." };

function deps({ canOpen = true, openFails = false } = {}) {
	const calls = { opened: [], copied: [] };
	return {
		calls,
		openURL: async (url) => {
			if (openFails) throw new Error("no app");
			calls.opened.push(url);
		},
		canOpenURL: async () => canOpen,
		setString: async (text) => {
			calls.copied.push(text);
		},
	};
}

test("opens the mail app on a mailto link with the contact's address and the filled subject and body", async () => {
	const d = deps();
	assert.equal(await openInMailApp(email, d), "opened");
	assert.deepEqual(d.calls.opened, [
		"mailto:sam@acme.test?subject=Thank%20you%20%26%20more&body=Hello%20Sam%2C%0D%0AThanks%20for%20your%20time.",
	]);
	assert.deepEqual(d.calls.copied, []);
});

test("leaves the recipient out when the contact has no address", async () => {
	const d = deps();
	await openInMailApp({ ...email, to: null }, d);
	assert.ok(d.calls.opened[0]?.startsWith("mailto:?subject="));
});

test("copies instead when the link would be longer than 1 800 characters", async () => {
	const d = deps();
	const long = { ...email, body: "word ".repeat(600) };
	assert.equal(await openInMailApp(long, d), "copied-long");
	assert.deepEqual(d.calls.opened, []);
	assert.deepEqual(d.calls.copied, [`${long.subject}\n\n${long.body}`]);
});

test("copies instead when no app can open the link, or opening fails", async () => {
	const none = deps({ canOpen: false });
	assert.equal(await openInMailApp(email, none), "copied-unavailable");
	assert.deepEqual(none.calls.copied, [`${email.subject}\n\n${email.body}`]);
	const broken = deps({ openFails: true });
	assert.equal(await openInMailApp(email, broken), "copied-unavailable");
	assert.equal(broken.calls.copied.length, 1);
});

test("copy puts the subject on its own line, then the body", async () => {
	const d = deps();
	await copyEmail(email, d);
	assert.deepEqual(d.calls.copied, ["Thank you & more\n\nHello Sam,\nThanks for your time."]);
});

test("the built-in text twin is the web one, and the settings row is wired", () => {
	const web = readFileSync(new URL("../../web/src/features/email-templates/built-in-text.ts", import.meta.url), "utf8");
	const mobile = readFileSync(new URL("../src/features/email-templates/built-in-text.ts", import.meta.url), "utf8");
	assert.equal(mobile, web);
	const settings = readFileSync(new URL("../app/(tabs)/settings/index.tsx", import.meta.url), "utf8");
	assert.ok(settings.includes('routes.settings("email-templates")'));
});
