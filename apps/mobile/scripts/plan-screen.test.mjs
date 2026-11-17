// Run: node --test apps/mobile/scripts/plan-screen.test.mjs
// CAREEROS (P3-T06, phase plan D10): the read-only Plan screen. The rules are a pure module and run as shipped. The
// screen is checked as source, and the whole phone app is scanned, so a purchase, upgrade or web checkout link cannot
// slip in: the app store rules restrict selling subscriptions outside in-app purchase.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { transformSync } = createRequire(serverRequire.resolve("tsx"))("esbuild");

function load(url) {
	const module = { exports: {} };
	const code = transformSync(readFileSync(url, "utf8"), { loader: "ts", format: "cjs" }).code;
	new Function("require", "module", "exports", code)(
		() => assert.fail("no dependencies expected"),
		module,
		module.exports,
	);
	return module.exports;
}

const view = load(new URL("../src/features/organization/plan-view.ts", import.meta.url));
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function walk(directory, found = []) {
	for (const name of readdirSync(directory)) {
		if (name === "node_modules" || name === "locales") continue;
		const path = `${directory}/${name}`;
		if (statSync(path).isDirectory()) walk(path, found);
		else if (/\.(ts|tsx)$/.test(name)) found.push(path);
	}
	return found;
}

test("plan names are readable and unknown ones keep their id", () => {
	assert.equal(view.planNameFor("starter"), "Starter");
	assert.equal(view.planNameFor("personal"), "Personal");
	assert.equal(view.planNameFor("campus"), "Campus");
});

test("days left round up and never go below zero", () => {
	const now = new Date("2026-11-09T00:00:00Z");
	assert.equal(view.daysLeft(new Date("2026-11-12T00:00:00Z"), now), 3);
	assert.equal(view.daysLeft(new Date("2026-11-08T00:00:00Z"), now), 0);
	assert.equal(view.daysLeft(null, now), null);
	assert.equal(view.daysLeft(undefined, now), null);
});

test("the quota view shows used, left and the share used, and nothing when there is no allowance", () => {
	assert.deepEqual(view.quotaView({ used: 40, allowance: 100 }), { used: 40, left: 60, percent: 40 });
	assert.deepEqual(view.quotaView({ used: 130, allowance: 100 }), { used: 130, left: 0, percent: 100 });
	assert.equal(view.quotaView({ used: 0, allowance: 0 }), null);
});

test("the Plan screen shows plan, status, seats and AI quota and only reads", () => {
	const screen = source("../src/features/organization/plan-screen.tsx");
	for (const label of ["Status", "Seats", "AI quota", "Used", "Left"]) assert.ok(screen.includes(label), label);
	for (const read of ["useEntitlements", "orpc.ai.quota", "orpc.billing.get"]) assert.ok(screen.includes(read), read);
	const code = screen.replace(/\/\/.*$/gm, "");
	assert.ok(!/mutation|useMutation|openBrowser|Linking/i.test(code), "no action in the screen");
	// The only press handler is the retry of a failed read.
	assert.deepEqual(code.match(/onPress: \(\) => [^,}]*/g), ["onPress: () => void entitlements.refetch() "]);
});

test("no purchase, upgrade, seat change, cancel or invoice call exists anywhere in the phone app", () => {
	const root = new URL("../", import.meta.url).pathname;
	const files = [...walk(`${root}src`), ...walk(`${root}app`)];
	assert.ok(files.length > 50);
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const forbidden of [
			/billing\.checkout/,
			/billing\.portal/,
			/billing\.changeSeats/,
			/billing\.cancel/,
			/billing\.startTrial/,
			/billing\.invoices/,
			/organization\/billing/,
			/\/api\/billing/,
		])
			assert.ok(!forbidden.test(text), `${file} matches ${forbidden}`);
	}
});

test("the Plan screen shows no price: it never reads the plan table's price fields", () => {
	const screen = source("../src/features/organization/plan-screen.tsx");
	assert.ok(!/price|priceMonthly|priceAnnual|KES|USD|\$\{?amount/i.test(screen.replace(/\/\/.*$/gm, "")));
});

test("Settings lists the Plan row for every member, outside the admin-only group", () => {
	const settings = source("../app/(tabs)/settings/index.tsx");
	const planRow = settings.indexOf('routes.settings("plan")');
	assert.ok(planRow > 0);
	assert.ok(planRow < settings.indexOf("canManageBrand ?"), "the Plan row comes before the admin-only group");
});
