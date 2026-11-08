// CAREEROS (P5-T03): the three calls the clip view makes with the clipper token, each to the connected organization only
// (`callApi` refuses any other origin before a byte leaves): the duplicate check, the save and the optional AI tidy. Every
// answer is read as untrusted: a value that is not the expected shape is "no answer". Errors become a small set of kinds
// the popup words for the member; the server's own text is never shown.
import type { ClipFields } from "./posting";
import { callApi, type ApiResult, type Session } from "./session";

export type ClipError = "signed_out" | "suspended" | "quota" | "offline" | "failed";

export type SaveResult = { ok: true; id: string } | { ok: false; error: ClipError };

export function clipErrorOf(result: Extract<ApiResult<unknown>, { ok: false }>): ClipError {
	if (result.reason === "unauthorized") return "signed_out";
	if (result.reason === "unreachable") return "offline";
	if (result.code === "ORG_SUSPENDED") return "suspended";
	if (result.code === "AI_QUOTA_EXCEEDED") return "quota";
	return "failed";
}

const JSON_HEADERS = { "content-type": "application/json" };

/** The clip as the applications.create body: the first stage ("saved") and the clipper marker. Empty optional fields are left out. */
export function saveBody(fields: ClipFields): Record<string, string> {
	const body: Record<string, string> = {
		company: fields.company.trim(),
		role: fields.title.trim(),
		status: "saved",
		source: "clipper",
	};
	if (fields.location.trim()) body.location = fields.location.trim();
	if (fields.salary.trim()) body.salary = fields.salary.trim();
	if (fields.url.trim()) body.sourceUrl = fields.url.trim();
	if (fields.description.trim()) body.jobDescription = fields.description.trim();
	return body;
}

export async function saveClip(
	session: Session,
	origin: string,
	fields: ClipFields,
	fetcher: typeof fetch = fetch,
): Promise<SaveResult> {
	const result = await callApi<unknown>(
		session,
		origin,
		"/api/openapi/applications",
		{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(saveBody(fields)) },
		fetcher,
	);
	if (!result.ok) return { ok: false, error: clipErrorOf(result) };
	// The answer is the new application's id, as a JSON string.
	return typeof result.data === "string" && /^[\w-]{1,100}$/.test(result.data)
		? { ok: true, id: result.data }
		: { ok: false, error: "failed" };
}

export type Duplicate = { id: string; title: string };

/** The member's own application with this address in this organization, or `null`. A failed check is also `null`: it never blocks saving. */
export async function findDuplicate(
	session: Session,
	origin: string,
	url: string,
	fetcher: typeof fetch = fetch,
): Promise<Duplicate | null> {
	if (!url) return null;
	const result = await callApi<{ match?: { id?: unknown; title?: unknown } | null }>(
		session,
		origin,
		`/api/openapi/clipper/find-by-url?url=${encodeURIComponent(url)}`,
		{},
		fetcher,
	);
	if (!result.ok) return null;
	const match = result.data?.match;
	if (!match || typeof match.id !== "string" || !/^[\w-]{1,100}$/.test(match.id)) return null;
	return { id: match.id, title: typeof match.title === "string" ? match.title.slice(0, 300) : "" };
}

/** Whether "Tidy with AI" may be offered (the plan includes platform AI and the allowance has credits left). False when unknown. */
export async function tidyAvailable(session: Session, origin: string, fetcher: typeof fetch = fetch): Promise<boolean> {
	const result = await callApi<{ tidyAvailable?: unknown }>(
		session,
		origin,
		"/api/openapi/clipper/whoami",
		{},
		fetcher,
	);
	return result.ok && result.data?.tidyAvailable === true;
}

export type TidyResult =
	| { ok: true; tidied: boolean; fields: Pick<ClipFields, "title" | "company" | "location" | "salary" | "description"> }
	| { ok: false; error: ClipError };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The AI tidy of the form's text fields. The answer replaces nothing the member has not seen: the form shows it as an edit. */
export async function tidyClip(
	session: Session,
	origin: string,
	fields: ClipFields,
	fetcher: typeof fetch = fetch,
): Promise<TidyResult> {
	const result = await callApi<{ tidied?: unknown; fields?: Record<string, unknown> }>(
		session,
		origin,
		"/api/openapi/clipper/cleanup",
		{
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				title: fields.title,
				company: fields.company,
				location: fields.location,
				salary: fields.salary,
				description: fields.description,
			}),
		},
		fetcher,
	);
	if (!result.ok) return { ok: false, error: clipErrorOf(result) };
	const out = result.data?.fields;
	if (!out || typeof out !== "object") return { ok: false, error: "failed" };
	return {
		ok: true,
		tidied: result.data?.tidied === true,
		fields: {
			title: text(out.title),
			company: text(out.company),
			location: text(out.location),
			salary: text(out.salary),
			description: text(out.description),
		},
	};
}
