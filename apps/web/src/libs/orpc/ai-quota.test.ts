import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import { noticeAiQuotaExceeded, noticeAiQuotaWarning, resetAiQuotaNotice } from "./ai-quota";

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
