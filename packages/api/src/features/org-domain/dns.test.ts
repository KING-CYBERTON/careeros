import { describe, expect, it } from "vite-plus/test";
import { checkTxtProof, lookupTxt, txtName, txtValue } from "./dns";

// P2-T06: the TXT proof, over an injected resolver (no DNS traffic).
const failing = (code: string) => async () => {
	throw Object.assign(new Error(code), { code });
};

describe("TXT proof", () => {
	it("names the record at _careeros-verify.<hostname> and the value careeros-verify=<token>", () => {
		expect(txtName("careers.acme.test")).toBe("_careeros-verify.careers.acme.test");
		expect(txtValue("abc")).toBe("careeros-verify=abc");
	});

	it("proves ownership when one TXT value equals the token's value, joining split chunks", async () => {
		await expect(checkTxtProof("a.test", "tok", async () => [["other"], ["careeros-verify=", "tok"]])).resolves.toBe(
			"proved",
		);
		await expect(checkTxtProof("a.test", "tok", async () => [["careeros-verify=tok2"]])).resolves.toBe("missing");
		await expect(checkTxtProof("a.test", "tok", async () => [["xcareeros-verify=tok"]])).resolves.toBe("missing");
	});

	it("reports a record that is not there as missing, and a failed lookup as unknown", async () => {
		await expect(lookupTxt("n", failing("ENODATA"))).resolves.toEqual({ state: "missing" });
		await expect(lookupTxt("n", failing("ENOTFOUND"))).resolves.toEqual({ state: "missing" });
		for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"])
			await expect(lookupTxt("n", failing(code))).resolves.toEqual({ state: "unknown" });
		await expect(checkTxtProof("a.test", "tok", failing("ETIMEOUT"))).resolves.toBe("unknown");
	});

	it("queries only the TXT name it was given", async () => {
		const seen: string[] = [];
		await checkTxtProof("a.test", "tok", async (name) => {
			seen.push(name);
			return [];
		});
		expect(seen).toEqual(["_careeros-verify.a.test"]);
	});
});
