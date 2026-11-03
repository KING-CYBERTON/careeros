// Run: node --test apps/mobile/scripts/ai-quota.test.mjs
// CAREEROS (P3-T03): the 80% and 100% AI allowance notices. The module under test is loaded for real; the toast UI,
// the message module and the error class are fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const mobile = new URL("../", import.meta.url);
const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { transformSync } = createRequire(requireServer.resolve("tsx"))("esbuild");

const toasts = [];
class FakeOrpcError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const modules = {
	"@lingui/core/macro": { t: (parts, ...values) => String.raw({ raw: parts }, ...values) },
	"@orpc/client": { ORPCError: FakeOrpcError },
	"@/features/ai/error": { aiQuotaExceededMessage: () => "allowance used up" },
	"@/ui": { showToast: (options) => toasts.push(options.message) },
};
const filename = fileURLToPath(new URL("src/api/ai-quota.ts", mobile));
const code = transformSync(readFileSync(filename, "utf8"), { loader: "ts", format: "cjs", target: "es2022" }).code;
const exported = { exports: {} };
new Function("require", "module", "exports", code)((name) => modules[name], exported, exported.exports);
const quota = exported.exports;

test("only AI calls trigger a quota check", () => {
	assert.equal(quota.isAiCall(["ai", "improve"]), true);
	assert.equal(quota.isAiCall(["agent", "turn"]), true);
	assert.equal(quota.isAiCall(["applications", "ai", "autofill"]), true);
	assert.equal(quota.isAiCall(["applications", "list"]), false);
	assert.equal(quota.isAiCall(["ai", "quota"]), false);
	assert.equal(quota.isAiCall(["resume", "list"]), false);
});

test("the watcher reads ai/quota after an AI call and notifies once at 80%", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		let reads = 0;
		let notices = 0;
		const watcher = quota.createAiQuotaWatcher({
			fetchQuota: async () => {
				reads += 1;
				return { warning: reads >= 2 };
			},
			notify: () => {
				notices += 1;
			},
		});
		watcher.afterCall(["resume", "list"]);
		mock.timers.tick(60_000);
		assert.equal(reads, 0, "a call that cannot use AI never reads the quota");

		watcher.afterCall(["ai", "improve"]);
		watcher.afterCall(["ai", "improve"]);
		mock.timers.tick(3000);
		await Promise.resolve();
		assert.equal(reads, 1, "one read for a burst of calls");
		assert.equal(notices, 0);

		watcher.afterCall(["ai", "improve"]);
		mock.timers.tick(3000);
		await Promise.resolve();
		assert.equal(reads, 1, "the minimum gap holds the next read back");
		mock.timers.tick(15_000);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(reads, 2);
		assert.equal(notices, 1);

		watcher.afterCall(["ai", "improve"]);
		mock.timers.tick(60_000);
		await Promise.resolve();
		assert.equal(reads, 2, "once warned, no more reads");
	} finally {
		mock.timers.reset();
	}
});

test("the 80% notice shows once, from the header or the read", () => {
	toasts.length = 0;
	quota.noticeAiQuotaWarning({});
	assert.equal(toasts.length, 0);
	quota.noticeAiQuotaWarning(new Headers({ "x-ai-quota-warning": "true" }));
	quota.showAiQuotaWarning();
	assert.equal(toasts.length, 1);
});

test("the 100% message shows for AI_QUOTA_EXCEEDED only", () => {
	toasts.length = 0;
	quota.noticeAiQuotaExceeded(new FakeOrpcError("BAD_REQUEST"));
	assert.equal(toasts.length, 0);
	quota.noticeAiQuotaExceeded(new FakeOrpcError("AI_QUOTA_EXCEEDED"));
	assert.deepEqual(toasts, ["allowance used up"]);
});
