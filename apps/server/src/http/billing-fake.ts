// CAREEROS (P3-T04, phase plan D1): the fake provider's approve-or-decline test page. `GET /api/billing/fake/checkout`
// shows the checkout; `POST /api/billing/fake/decision` posts the signed fake event to the fake webhook intake and sends
// the browser back. It exists only while BILLING_PROVIDER=fake (which packages/env refuses in production) and only on
// the platform host; everywhere else it is a 404. The session token in the address is signed and names the organization.
import type { HostContext } from "@careeros/tenancy";
import { consumeBillingLimit, decideFakeCheckout, readFakeCheckout } from "@reactive-resume/api/features/billing";
import { env } from "@reactive-resume/env/server";

const BASE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const PAGE_HEADERS = {
	...BASE_HEADERS,
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"X-Frame-Options": "DENY",
};

const notFound = () => new Response("Not found", { status: 404, headers: BASE_HEADERS });

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);

const enabled = (host: HostContext) => host.kind === "platform" && env.BILLING_PROVIDER === "fake";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function handleFakeCheckoutPage(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (!enabled(host)) return notFound();
	if (!(await consumeBillingLimit("fakeCheckout", trustedClient)))
		return new Response("Too many requests", { status: 429, headers: { ...BASE_HEADERS, "Retry-After": "60" } });
	const token = new URL(request.url).searchParams.get("session") ?? "";
	const session = readFakeCheckout(token);
	if (!session)
		return new Response("This test checkout has expired or is not valid. Start again from billing.", {
			status: 400,
			headers: BASE_HEADERS,
		});
	const field = `<input type="hidden" name="session" value="${escapeHtml(token)}">`;
	const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test checkout</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}
.note{color:#7a4b00;background:#fff4dc;padding:.5rem .75rem;border-radius:.25rem}</style></head>
<body><h1>Test checkout</h1>
<p class="note">This is the fake payment provider for tests. No money moves.</p>
<dl><dt>Plan</dt><dd>${escapeHtml(session.planId)}</dd><dt>Seats</dt><dd>${session.seats}</dd>
<dt>Billed</dt><dd>${session.interval === "year" ? "yearly" : "monthly"}</dd><dt>Amount</dt><dd>${escapeHtml(dollars(session.amount))}</dd>
<dt>Customer</dt><dd>${escapeHtml(session.email)}</dd></dl>
<form method="post" action="/api/billing/fake/decision">${field}
<button type="submit" name="decision" value="approve">Approve payment</button>
<button type="submit" name="decision" value="decline">Decline payment</button></form></body></html>`;
	return new Response(page, { status: 200, headers: PAGE_HEADERS });
}

export async function handleFakeCheckoutDecision(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (!enabled(host)) return notFound();
	// A browser always sends Origin on a POST and a cross-site page cannot forge it: it must be the platform's own.
	if (request.headers.get("origin") !== new URL(env.APP_URL).origin)
		return new Response("Forbidden", { status: 403, headers: BASE_HEADERS });
	if (!(await consumeBillingLimit("fakeCheckout", trustedClient)))
		return new Response("Too many requests", { status: 429, headers: { ...BASE_HEADERS, "Retry-After": "60" } });
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return new Response("Bad request", { status: 400, headers: BASE_HEADERS });
	}
	const token = form.get("session");
	const decision = form.get("decision");
	if (typeof token !== "string" || (decision !== "approve" && decision !== "decline"))
		return new Response("Bad request", { status: 400, headers: BASE_HEADERS });
	try {
		const result = await decideFakeCheckout(token, decision);
		if (!result.ok)
			return new Response("This test checkout has expired. Start again from billing.", {
				status: 400,
				headers: BASE_HEADERS,
			});
		const target = new URL(result.returnUrl);
		target.searchParams.set("billing", result.result);
		return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: target.toString() } });
	} catch (error) {
		console.error("[billing] fake checkout decision failed", error instanceof Error ? error.name : "");
		return new Response("The test payment could not be recorded.", { status: 500, headers: BASE_HEADERS });
	}
}
