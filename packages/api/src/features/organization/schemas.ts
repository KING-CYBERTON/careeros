import z from "zod";

// CAREEROS (P3-T01): read-only entitlements and audit log of the current organization.

export const entitlementsSchema = z.object({
	planId: z.string().describe("The plan the organization is on, for example `personal` or `pro`."),
	status: z.enum(["trial", "active", "past_due", "suspended"]),
	seatLimit: z.number().int().nullable().describe("Null means unlimited."),
	seatsUsed: z.number().int().describe("Members plus pending invitations that have not expired."),
	aiCreditsPerSeat: z.number().int(),
	aiCreditsTotal: z.number().int().describe("The pooled credits: credits per seat times max(seats paid, members)."),
	features: z.record(z.string(), z.boolean()).describe("Every feature with the plan's flags and overrides applied."),
	overageAllowed: z.boolean().describe("Whether AI calls may continue past the credits."),
	readOnly: z.boolean().describe("True while the organization is suspended: it can read and export, not write."),
});

export const auditListInput = z.object({
	limit: z.number().int().min(1).max(100).optional().describe("Entries per page (1 to 100). Defaults to 50."),
	cursor: z
		.string()
		.max(128)
		.optional()
		.describe("The `nextCursor` of the previous page. Omit for the newest entries."),
});

export const auditEntrySchema = z.object({
	id: z.string(),
	action: z.string().describe("A dotted lowercase name such as `org.plan_changed`."),
	actorUserId: z.string().nullable().describe("Null for the system, or when the user has been deleted."),
	impersonatorUserId: z.string().nullable().describe("Set when a platform admin acted as the actor (impersonation)."),
	targetType: z.string().nullable(),
	targetId: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.date(),
});

export const auditListSchema = z.object({
	items: z.array(auditEntrySchema),
	nextCursor: z.string().nullable().describe("Pass as `cursor` for the next (older) page; null on the last page."),
});

export type AuditListInput = z.infer<typeof auditListInput>;
