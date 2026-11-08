import type { Session } from "./session";
import { describe, expect, it, vi } from "vite-plus/test";
import { clipErrorOf, findDuplicate, saveBody, saveClip, tidyAvailable, tidyClip } from "./clip-api";
import { EMPTY_FIELDS } from "./posting";

const origin = "https://careers.example.org";
const session: Session = { origin, token: "cos_clip_secret", userName: "Ada" };
const fields = { ...EMPTY_FIELDS, title: " Engineer ", company: "Acme", url: "https://acme.example.test/jobs/1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("saveBody", () => {
	it("sends the first stage and the clipper marker, and leaves empty optional fields out", () => {
		expect(saveBody(fields)).toEqual({
			company: "Acme",
			role: "Engineer",
			status: "saved",
			source: "clipper",
			sourceUrl: "https://acme.example.test/jobs/1",
		});
	});
});

describe("saveClip", () => {
	it("posts to the organization's applications with the token and returns the id", async () => {
		const fetcher = vi.fn().mockResolvedValue(json("app_123"));
		expect(await saveClip(session, origin, fields, fetcher as never)).toEqual({ ok: true, id: "app_123" });
		const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${origin}/api/openapi/applications`);
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer cos_clip_secret");
		expect(init.credentials).toBe("omit");
	});

	it("maps each failure to a kind", async () => {
		const run = (response: Response | Error) =>
			saveClip(
				session,
				origin,
				fields,
				(response instanceof Error
					? vi.fn().mockRejectedValue(response)
					: vi.fn().mockResolvedValue(response)) as never,
			);
		expect(await run(json({}, 401))).toEqual({ ok: false, error: "signed_out" });
		expect(await run(json({ code: "FORBIDDEN", data: { code: "ORG_SUSPENDED" } }, 403))).toEqual({
			ok: false,
			error: "suspended",
		});
		expect(await run(new TypeError("offline"))).toEqual({ ok: false, error: "offline" });
		expect(await run(json({}, 500))).toEqual({ ok: false, error: "failed" });
		expect(await run(json({ not: "an id" }))).toEqual({ ok: false, error: "failed" });
	});

	it("refuses to send to another organization's origin", async () => {
		const fetcher = vi.fn();
		const result = await saveClip(session, "https://other.example.org", fields, fetcher as never);
		expect(result).toEqual({ ok: false, error: "failed" });
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("findDuplicate", () => {
	it("returns the match, and null for no match, a bad answer or a failure", async () => {
		const found = vi.fn().mockResolvedValue(json({ match: { id: "app_1", title: "Engineer" } }));
		expect(await findDuplicate(session, origin, fields.url, found as never)).toEqual({
			id: "app_1",
			title: "Engineer",
		});
		expect((found.mock.calls[0] as [string])[0]).toBe(
			`${origin}/api/openapi/clipper/find-by-url?url=${encodeURIComponent(fields.url)}`,
		);
		expect(
			await findDuplicate(session, origin, fields.url, vi.fn().mockResolvedValue(json({ match: null })) as never),
		).toBeNull();
		expect(
			await findDuplicate(
				session,
				origin,
				fields.url,
				vi.fn().mockResolvedValue(json({ match: { id: "<x>" } })) as never,
			),
		).toBeNull();
		expect(
			await findDuplicate(session, origin, fields.url, vi.fn().mockResolvedValue(json({}, 500)) as never),
		).toBeNull();
		const none = vi.fn();
		expect(await findDuplicate(session, origin, "", none as never)).toBeNull();
		expect(none).not.toHaveBeenCalled();
	});
});

describe("tidy", () => {
	it("is offered only when the server says so", async () => {
		expect(
			await tidyAvailable(session, origin, vi.fn().mockResolvedValue(json({ tidyAvailable: true })) as never),
		).toBe(true);
		expect(
			await tidyAvailable(session, origin, vi.fn().mockResolvedValue(json({ tidyAvailable: "yes" })) as never),
		).toBe(false);
		expect(await tidyAvailable(session, origin, vi.fn().mockResolvedValue(json({}, 500)) as never)).toBe(false);
	});

	it("returns the tidied fields, or the quota error", async () => {
		const out = { title: "Engineer", company: "Acme", location: "", salary: "", description: "Text" };
		const ok = vi.fn().mockResolvedValue(json({ tidied: true, fields: out }));
		expect(await tidyClip(session, origin, fields, ok as never)).toEqual({ ok: true, tidied: true, fields: out });
		const quota = vi.fn().mockResolvedValue(json({ code: "AI_QUOTA_EXCEEDED" }, 402));
		expect(await tidyClip(session, origin, fields, quota as never)).toEqual({ ok: false, error: "quota" });
	});
});

describe("clipErrorOf", () => {
	it("maps reasons and codes", () => {
		expect(clipErrorOf({ ok: false, reason: "failed", code: "AI_QUOTA_EXCEEDED" })).toBe("quota");
		expect(clipErrorOf({ ok: false, reason: "refused" })).toBe("failed");
	});
});
