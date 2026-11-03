import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import {
	createAiQuotaWatcher,
	isAiCall,
	noticeAiQuotaExceeded,
	noticeAiQuotaWarning,
	resetAiQuotaNotice,
	showAiQuotaWarning,
} from "./ai-quota";

// CAREEROS (P3-T03): the 80% and 100% AI allowance notices.
const add = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add } }));

i18n.load("en", {});
i18n.activate("en");

describe("the AI allowance notices", () => {
	beforeEach(() => {
		add.mockClear();
		resetAiQuotaNotice();
	});

	it("shows the 80% notice once, whatever the header shape", () => {
		noticeAiQuotaWarning(new Headers({ "x-ai-quota-warning": "true" }));
		noticeAiQuotaWarning({ "x-ai-quota-warning": "true" });
		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]?.[0]).toMatchObject({ type: "warning" });
	});

	it("stays quiet without the header", () => {
		noticeAiQuotaWarning(new Headers());
		noticeAiQuotaWarning({});
		noticeAiQuotaWarning(undefined);
		expect(add).not.toHaveBeenCalled();
	});

	it("shows the 100% message for AI_QUOTA_EXCEEDED only", () => {
		noticeAiQuotaExceeded(new ORPCError("BAD_REQUEST"));
		noticeAiQuotaExceeded(new Error("other"));
		expect(add).not.toHaveBeenCalled();
		noticeAiQuotaExceeded(new ORPCError("AI_QUOTA_EXCEEDED", { status: 402 }));
		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]?.[0]).toMatchObject({ type: "error" });
	});
});

describe("the ai/quota read after AI calls", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("names the calls that can use AI", () => {
		expect(isAiCall(["ai", "improve"])).toBe(true);
		expect(isAiCall(["agent", "threads", "create"])).toBe(true);
		expect(isAiCall(["applications", "ai", "autofill"])).toBe(true);
		expect(isAiCall(["applications", "list"])).toBe(false);
		expect(isAiCall(["ai", "quota"])).toBe(false);
		expect(isAiCall(["resume", "list"])).toBe(false);
	});

	it("reads the quota once per burst, respects the gap, and notifies once at 80%", async () => {
		let reads = 0;
		const notify = vi.fn();
		const watcher = createAiQuotaWatcher({
			fetchQuota: async () => ({ warning: ++reads >= 2 }),
			notify,
		});
		watcher.afterCall(["resume", "list"]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toBe(0);

		watcher.afterCall(["ai", "improve"]);
		watcher.afterCall(["ai", "improve"]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(reads).toBe(1);

		watcher.afterCall(["ai", "improve"]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(reads).toBe(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(reads).toBe(2);
		expect(notify).toHaveBeenCalledTimes(1);

		watcher.afterCall(["ai", "improve"]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toBe(2);
	});

	it("keeps going after a failed read", async () => {
		let reads = 0;
		const notify = vi.fn();
		const watcher = createAiQuotaWatcher({
			fetchQuota: async () => {
				if (++reads === 1) throw new Error("offline");
				return { warning: true };
			},
			notify,
		});
		watcher.afterCall(["ai", "improve"]);
		await vi.advanceTimersByTimeAsync(3000);
		watcher.afterCall(["ai", "improve"]);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("shows the notice only once between the header and the read", () => {
		vi.useRealTimers();
		add.mockClear();
		resetAiQuotaNotice();
		noticeAiQuotaWarning(new Headers({ "x-ai-quota-warning": "true" }));
		showAiQuotaWarning();
		expect(add).toHaveBeenCalledTimes(1);
	});
});
