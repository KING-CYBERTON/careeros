import { Resolver } from "node:dns/promises";

// CAREEROS (P2-T06): the TXT lookup that proves an organization controls a domain. DNS only (node:dns/promises): the
// hostname is never fetched over HTTP, so there is no server-side request to an address a stranger chose.

export const TXT_LABEL = "_careeros-verify";
const LOOKUP_TIMEOUT_MS = 5_000;

export const txtName = (hostname: string) => `${TXT_LABEL}.${hostname}`;
export const txtValue = (token: string) => `careeros-verify=${token}`;

/**
 * `found`: the name answered (the values may or may not hold the proof). `missing`: DNS says the record is not there
 * (NXDOMAIN or no TXT data). `unknown`: the lookup itself failed (timeout, SERVFAIL, refused), which says nothing about
 * the record, so a daily check never counts it as a missing record.
 */
export type TxtLookup = { state: "found"; values: string[] } | { state: "missing" } | { state: "unknown" };

export type ResolveTxt = (name: string) => Promise<string[][]>;

let resolver: Resolver | undefined;
const defaultResolveTxt: ResolveTxt = (name) => {
	resolver ??= new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
	return resolver.resolveTxt(name);
};

export async function lookupTxt(name: string, resolve: ResolveTxt = defaultResolveTxt): Promise<TxtLookup> {
	try {
		return { state: "found", values: (await resolve(name)).map((parts) => parts.join("")) };
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		return code === "ENODATA" || code === "ENOTFOUND" ? { state: "missing" } : { state: "unknown" };
	}
}

/** Whether the TXT record at `_careeros-verify.<hostname>` holds this organization's token. */
export async function checkTxtProof(
	hostname: string,
	token: string,
	resolve?: ResolveTxt,
): Promise<"proved" | "missing" | "unknown"> {
	const lookup = await lookupTxt(txtName(hostname), resolve);
	if (lookup.state !== "found") return lookup.state;
	const expected = txtValue(token);
	return lookup.values.some((value) => value.trim() === expected) ? "proved" : "missing";
}
