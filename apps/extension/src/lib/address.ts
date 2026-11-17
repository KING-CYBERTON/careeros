// CAREEROS (P5-T01): the organization address the user types, turned into one https origin. Pure, so it is tested
// without a browser. http is accepted only for the hosts a development build lists (`devHttpHosts`); a production build
// lists none.

export type AddressError =
	/** Nothing was typed. */
	| "empty"
	/** Not a web address. */
	| "invalid"
	/** A scheme other than http or https. */
	| "scheme"
	/** The address carries a user name or password. */
	| "credentials"
	/** http for a host that is not a development host. */
	| "insecure"
	/** A single-label name or an IP address: an organization address is a domain name. */
	| "host";

export type AddressResult = { ok: true; origin: string } | { ok: false; reason: AddressError };

/** True when `hostname` matches an entry of `devHttpHosts`: an exact host, or `*.suffix` for any subdomain of it. */
export function isDevHttpHost(hostname: string, devHttpHosts: readonly string[]): boolean {
	return devHttpHosts.some((entry) =>
		entry.startsWith("*.")
			? hostname.endsWith(entry.slice(1)) && hostname.length > entry.length - 1
			: hostname === entry,
	);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_LIKE = /^[0-9.]+$/;

/**
 * Normalizes a host or an https URL to an origin: lowercase, punycode for international names, no path, query or
 * fragment, no default port. Refuses user info, other schemes, IP addresses and single-label names. http is refused
 * unless the host is listed in `devHttpHosts`.
 */
export function normalizeOrigin(input: string, devHttpHosts: readonly string[] = []): AddressResult {
	const raw = input.trim();
	if (raw === "") return { ok: false, reason: "empty" };
	if (/\s/.test(raw)) return { ok: false, reason: "invalid" };

	const parse = (value: string): URL | null => {
		try {
			return new URL(value);
		} catch {
			return null;
		}
	};
	const hasScheme = SCHEME.test(raw);
	let url = parse(hasScheme ? raw : `https://${raw}`);
	if (!url) return { ok: false, reason: "invalid" };
	if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme" };
	if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };

	// A fully qualified name ("example.com.") is the same host.
	const hostname = url.hostname.replace(/\.$/, "");
	const development = isDevHttpHost(hostname, devHttpHosts);
	if (!development && (hostname.startsWith("[") || IPV4_LIKE.test(hostname) || !hostname.includes(".")))
		return { ok: false, reason: "host" };
	if (url.protocol === "http:" && !development) return { ok: false, reason: "insecure" };

	// A bare host in a development build uses http, so `localhost:3000` works as typed.
	if (!hasScheme && development) {
		url = parse(`http://${raw}`);
		if (!url) return { ok: false, reason: "invalid" };
	}
	return { ok: true, origin: `${url.protocol}//${hostname}${url.port === "" ? "" : `:${url.port}`}` };
}

/** The match pattern to request host permission for one origin. */
export function permissionPattern(origin: string): string {
	return `${origin}/*`;
}
