import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { NOTICE_ENTRIES, NOTICE_INTRO } from "./notice";

const notice = readFileSync(fileURLToPath(new URL("../../../NOTICE", import.meta.url)), "utf8");

describe("licenses page notice text", () => {
	it("matches the NOTICE file verbatim", () => {
		expect(notice).toContain(NOTICE_INTRO);
		for (const entry of NOTICE_ENTRIES) expect(notice).toContain(entry.license);
	});

	it("keeps the upstream copyright line", () => {
		expect(NOTICE_ENTRIES[0]?.license).toContain("Copyright (c) 2026 Amruth Pillai");
	});
});
