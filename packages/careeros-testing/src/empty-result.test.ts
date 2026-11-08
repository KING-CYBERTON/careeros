import { describe, expect, it } from "vite-plus/test";
import { isEmptyResult } from "./cross-org-inventory";

// CAREEROS (P3-T08): the cross-org fuzz accepts an empty page, and still fails on any row or a total above zero.
describe("isEmptyResult on a page shape", () => {
	it("accepts an empty page", () => {
		expect(isEmptyResult({ items: [], total: 0, page: 1, pageSize: 50 })).toBe(true);
	});

	it("rejects a page with a row", () => {
		expect(isEmptyResult({ items: [{ id: "x" }], total: 0, page: 1, pageSize: 50 })).toBe(false);
	});

	it("rejects a page whose total is above zero", () => {
		expect(isEmptyResult({ items: [], total: 3, page: 1, pageSize: 50 })).toBe(false);
	});
});
