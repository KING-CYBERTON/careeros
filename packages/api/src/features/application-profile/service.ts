import type { ApplicationProfileData } from "@reactive-resume/schema/application-profile";
// CAREEROS: the profile is per (organization, user) (P1-T06, D11)
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/client";
import { and, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { applicationProfile } from "@reactive-resume/db/schema";
import { applicationProfileDataSchema } from "@reactive-resume/schema/application-profile";
import { generateId } from "@reactive-resume/utils/string";
import { lockUser } from "../documents/ownership";

// CAREEROS (P1-T06, D11): every query names the current organization as well as the user, so a user in two
// organizations has a separate profile in each.
const ownProfile = (userId: string) =>
	and(eq(applicationProfile.organizationId, requireOrgId()), eq(applicationProfile.userId, userId));

export const applicationProfileService = {
	get: async (userId: string) => {
		const [row] = await db.select().from(applicationProfile).where(ownProfile(userId));
		return row
			? {
					data: applicationProfileDataSchema.parse(row.data),
					reviewedAt: row.reviewedAt.toISOString(),
					revision: row.revision,
				}
			: null;
	},
	save: (userId: string, input: { data: ApplicationProfileData; expectedRevision: string | null }) => {
		const data = applicationProfileDataSchema.parse(input.data);
		return db.transaction(async (tx) => {
			await lockUser(tx, userId);
			const [stored] = await tx.select().from(applicationProfile).where(ownProfile(userId));
			if ((stored?.revision ?? null) !== input.expectedRevision)
				throw new ORPCError("CONFLICT", { message: "The application profile changed. Reload it before saving." });
			const record = { data, reviewedAt: new Date(), revision: generateId() };
			await tx
				.insert(applicationProfile)
				.values({ organizationId: requireOrgId(), userId, ...record })
				.onConflictDoUpdate({ target: [applicationProfile.organizationId, applicationProfile.userId], set: record });
			return { ...record, reviewedAt: record.reviewedAt.toISOString() };
		});
	},
	delete: (userId: string, expectedRevision: string) =>
		db.transaction(async (tx) => {
			await lockUser(tx, userId);
			const [stored] = await tx.select().from(applicationProfile).where(ownProfile(userId));
			if (!stored) return;
			if (stored.revision !== expectedRevision)
				throw new ORPCError("CONFLICT", { message: "The application profile changed. Reload it before deleting." });
			await tx.delete(applicationProfile).where(ownProfile(userId));
		}),
};
