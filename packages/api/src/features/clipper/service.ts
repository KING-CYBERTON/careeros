import { normalizePostingUrl, postingHost } from "@careeros/job-posting";
import { requireOrgId } from "@careeros/tenancy";
import { and, desc, eq, ilike, isNotNull } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

// CAREEROS (P5-T03): the Job Clipper's duplicate check. It reads only the caller's own applications in the request's
// organization (the organization comes from the token's host, never from the request), and it answers at most an id and
// a title, so it cannot be used to read another member's tracker or another organization's.

/** Most rows looked at for one address: a member's applications on one host. */
const CANDIDATE_LIMIT = 200;

/** A `LIKE` pattern that matches the text literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export const clipperService = {
	/** The caller's newest application whose posting address is the same as `url`, or `null`. */
	findByUrl: async (input: { userId: string; url: string }): Promise<{ id: string; title: string } | null> => {
		const normalized = normalizePostingUrl(input.url);
		const host = postingHost(input.url);
		if (!normalized || !host) return null;

		const rows = await db
			.select({ id: schema.application.id, role: schema.application.role, sourceUrl: schema.application.sourceUrl })
			.from(schema.application)
			.where(
				and(
					eq(schema.application.organizationId, requireOrgId()),
					eq(schema.application.userId, input.userId),
					isNotNull(schema.application.sourceUrl),
					// The host narrows the search in the database; the exact comparison is below, on normalized addresses.
					ilike(schema.application.sourceUrl, `%${escapeLike(host)}%`),
				),
			)
			.orderBy(desc(schema.application.createdAt), schema.application.id)
			.limit(CANDIDATE_LIMIT);
		const match = rows.find((row) => normalizePostingUrl(row.sourceUrl) === normalized);
		return match ? { id: match.id, title: match.role } : null;
	},
};
