import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { asDate } from "./dates";
import { guarded } from "./errors";

// CAREEROS (P3-T07, requirement 4): announcements. Platform admins write them through `careeros_admin_announcement_*`
// (actor checked in the database, audited); members read what applies to the organization they are acting in and
// dismiss for themselves through `careeros_announcements_for_member` and `careeros_announcement_dismiss`.

export type AnnouncementSeverity = "info" | "warning";

export type AnnouncementInput = {
	/** Omit to create; give an id to update that announcement. */
	id?: string | undefined;
	title: string;
	/** Plain text, 1 to 1,000 characters. */
	body: string;
	severity: AnnouncementSeverity;
	startsAt: Date;
	endsAt: Date;
	/** Only members of organizations on this plan see it. */
	planId?: string | null | undefined;
	/** Only members of this organization see it. */
	organizationId?: string | null | undefined;
};

export type AdminAnnouncement = {
	id: string;
	title: string;
	body: string;
	severity: AnnouncementSeverity;
	startsAt: Date;
	endsAt: Date;
	planId: string | null;
	organizationId: string | null;
	createdBy: string | null;
	createdAt: Date;
};

type AnnouncementRow = {
	id: string;
	title: string;
	body: string;
	severity: string;
	starts_at: Date | string;
	ends_at: Date | string;
	plan_id: string | null;
	organization_id: string | null;
	created_by: string | null;
	created_at: Date | string;
};

/** Creates or updates an announcement. Returns its id. */
export function saveAnnouncement(actorUserId: string, input: AnnouncementInput): Promise<string> {
	return guarded(async () => {
		const { rows } = await db.execute<{ id: string }>(
			sql`select careeros_admin_announcement_save(${actorUserId}::text, ${input.id ?? null}::text, ${input.title}::text, ${input.body}::text, ${input.severity}::text, ${input.startsAt.toISOString()}::timestamptz, ${input.endsAt.toISOString()}::timestamptz, ${input.planId ?? null}::text, ${input.organizationId ?? null}::text) as id`,
		);
		return rows[0]?.id ?? "";
	});
}

/** The 200 most recent announcements. */
export function listAnnouncements(actorUserId: string): Promise<AdminAnnouncement[]> {
	return guarded(async () => {
		const { rows } = await db.execute<AnnouncementRow>(
			sql`select * from careeros_admin_announcement_list(${actorUserId}::text)`,
		);
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			body: row.body,
			severity: row.severity as AnnouncementSeverity,
			startsAt: asDate(row.starts_at),
			endsAt: asDate(row.ends_at),
			planId: row.plan_id,
			organizationId: row.organization_id,
			createdBy: row.created_by,
			createdAt: asDate(row.created_at),
		}));
	});
}

/** Ends a running announcement now. */
export function endAnnouncement(actorUserId: string, id: string): Promise<void> {
	return guarded(async () => {
		await db.execute(sql`select careeros_admin_announcement_end(${actorUserId}::text, ${id}::text)`);
	});
}

export type MemberAnnouncement = {
	id: string;
	title: string;
	body: string;
	severity: AnnouncementSeverity;
	startsAt: Date;
	endsAt: Date;
};

/** The announcements that apply to a member acting in an organization and that they have not dismissed. */
export async function activeAnnouncementsForMember(userId: string, orgId: string): Promise<MemberAnnouncement[]> {
	const { rows } = await db.execute<{
		id: string;
		title: string;
		body: string;
		severity: string;
		starts_at: Date | string;
		ends_at: Date | string;
	}>(sql`select * from careeros_announcements_for_member(${userId}::text, ${orgId}::text)`);
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		body: row.body,
		severity: row.severity as AnnouncementSeverity,
		startsAt: asDate(row.starts_at),
		endsAt: asDate(row.ends_at),
	}));
}

/** A member dismisses an announcement for themselves. True when it was newly dismissed. */
export async function dismissAnnouncement(userId: string, announcementId: string): Promise<boolean> {
	const { rows } = await db.execute<{ dismissed: boolean }>(
		sql`select careeros_announcement_dismiss(${userId}::text, ${announcementId}::text) as dismissed`,
	);
	return rows[0]?.dismissed === true;
}
