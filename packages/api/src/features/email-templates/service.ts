import type { RenderInput, TemplateCreateInput, TemplateUpdateInput } from "./schemas";
import type { StoredTemplate, TemplateEntry, TemplateValues, VariableName } from "@careeros/email-templates";
import { audit, type AuditContext } from "@careeros/billing";
import {
	builtInById,
	firstNameOf,
	isBuiltInId,
	isMailableAddress,
	renderSubject,
	renderTemplate,
	resolveTemplates,
	variablesIn,
} from "@careeros/email-templates";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { applicationService } from "../applications/service";
import { requireOrgAdmin } from "../org-admin/service";
import { formatInterview, MAX_VALUE_LENGTH, pickContact, pickInterviewDate } from "./fill";

// CAREEROS (P5-T04): email templates per application stage. Every function runs inside the request's organization scope
// (`protectedProcedure`), so row-level security keeps every query to the organization; the per-person rule is applied
// here: a member reads the organization's defaults (`user_id` is null) and their own rows, never another member's, and
// only an owner or admin writes a default. The organization id is never a parameter: it is `requireOrgId()`.

export type TemplateActor = { userId: string; ip?: string | null };

const auditContext = (actor: TemplateActor): AuditContext => ({ actorUserId: actor.userId, ip: actor.ip ?? null });

const columns = {
	id: schema.emailTemplate.id,
	userId: schema.emailTemplate.userId,
	kind: schema.emailTemplate.kind,
	stageCategory: schema.emailTemplate.stageCategory,
	name: schema.emailTemplate.name,
	subject: schema.emailTemplate.subject,
	body: schema.emailTemplate.body,
};

type Row = Pick<typeof schema.emailTemplate.$inferSelect, keyof typeof columns>;

const toStored = (row: Row): StoredTemplate => ({
	id: row.id,
	kind: row.kind,
	stageCategory: row.stageCategory,
	name: row.name,
	subject: row.subject,
	body: row.body,
});

/** The rows this member may see: the organization's active defaults and their own active templates. */
async function visibleRows(organizationId: string, userId: string): Promise<Row[]> {
	return await db
		.select(columns)
		.from(schema.emailTemplate)
		.where(
			and(
				eq(schema.emailTemplate.organizationId, organizationId),
				isNull(schema.emailTemplate.archivedAt),
				or(isNull(schema.emailTemplate.userId), eq(schema.emailTemplate.userId, userId)),
			),
		)
		.orderBy(asc(schema.emailTemplate.createdAt), asc(schema.emailTemplate.id));
}

/** Built-ins, the organization's defaults and the member's own, each with its `source`. */
export async function listTemplates(userId: string): Promise<TemplateEntry[]> {
	const organizationId = requireOrgId();
	const rows = await visibleRows(organizationId, userId);
	return resolveTemplates({
		org: rows.filter((row) => row.userId === null).map(toStored),
		mine: rows.filter((row) => row.userId === userId).map(toStored),
	});
}

/** The entry of one stored row, as `list` would show it. */
function entryOf(row: Row, source: "org" | "mine"): TemplateEntry {
	const stored = toStored(row);
	return {
		id: stored.id,
		source,
		kind: stored.kind,
		stageCategories: stored.stageCategory ? [stored.stageCategory] : [],
		name: stored.name,
		subject: stored.subject,
		body: stored.body,
	};
}

const notFound = () => new ORPCError("NOT_FOUND", { message: "Template not found." });

/** The values an update changes. `undefined` leaves a field alone; a null stage clears it. */
function changes(input: TemplateUpdateInput) {
	return {
		...(input.kind !== undefined && { kind: input.kind }),
		...(input.stageCategory !== undefined && { stageCategory: input.stageCategory }),
		...(input.name !== undefined && { name: input.name }),
		...(input.subject !== undefined && { subject: input.subject }),
		...(input.body !== undefined && { body: input.body }),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// A member's own templates

export async function createMine(userId: string, input: TemplateCreateInput): Promise<TemplateEntry> {
	const [row] = await db
		.insert(schema.emailTemplate)
		.values({
			organizationId: requireOrgId(),
			userId,
			kind: input.kind,
			stageCategory: input.stageCategory ?? null,
			name: input.name,
			subject: input.subject,
			body: input.body,
		})
		.returning(columns);
	if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
	return entryOf(row, "mine");
}

export async function updateMine(userId: string, input: TemplateUpdateInput): Promise<TemplateEntry> {
	const values = changes(input);
	const where = and(
		eq(schema.emailTemplate.organizationId, requireOrgId()),
		eq(schema.emailTemplate.id, input.id),
		eq(schema.emailTemplate.userId, userId),
		isNull(schema.emailTemplate.archivedAt),
	);
	if (Object.keys(values).length === 0) {
		const [row] = await db.select(columns).from(schema.emailTemplate).where(where).limit(1);
		if (!row) throw notFound();
		return entryOf(row, "mine");
	}
	const [row] = await db
		.update(schema.emailTemplate)
		.set({ ...values, updatedAt: new Date() })
		.where(where)
		.returning(columns);
	if (!row) throw notFound();
	return entryOf(row, "mine");
}

export async function archiveMine(userId: string, id: string): Promise<{ id: string }> {
	const updated = await db
		.update(schema.emailTemplate)
		.set({ archivedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(schema.emailTemplate.organizationId, requireOrgId()),
				eq(schema.emailTemplate.id, id),
				eq(schema.emailTemplate.userId, userId),
				isNull(schema.emailTemplate.archivedAt),
			),
		)
		.returning({ id: schema.emailTemplate.id });
	if (updated.length === 0) throw notFound();
	return { id };
}

// ---------------------------------------------------------------------------------------------------------------
// The organization's defaults: owners and admins only. One audit row per change, with ids and counts, never text.

export async function createOrgDefault(actor: TemplateActor, input: TemplateCreateInput): Promise<TemplateEntry> {
	const organizationId = await requireOrgAdmin(actor.userId);
	const [row] = await db
		.insert(schema.emailTemplate)
		.values({
			organizationId,
			userId: null,
			kind: input.kind,
			stageCategory: input.stageCategory ?? null,
			name: input.name,
			subject: input.subject,
			body: input.body,
		})
		.returning(columns);
	if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
	await audit(auditContext(actor), "email_template.org_created", { type: "email_template", id: row.id });
	return entryOf(row, "org");
}

export async function updateOrgDefault(actor: TemplateActor, input: TemplateUpdateInput): Promise<TemplateEntry> {
	const organizationId = await requireOrgAdmin(actor.userId);
	const values = changes(input);
	const where = and(
		eq(schema.emailTemplate.organizationId, organizationId),
		eq(schema.emailTemplate.id, input.id),
		isNull(schema.emailTemplate.userId),
		isNull(schema.emailTemplate.archivedAt),
	);
	if (Object.keys(values).length === 0) {
		const [row] = await db.select(columns).from(schema.emailTemplate).where(where).limit(1);
		if (!row) throw notFound();
		return entryOf(row, "org");
	}
	const [row] = await db
		.update(schema.emailTemplate)
		.set({ ...values, updatedAt: new Date() })
		.where(where)
		.returning(columns);
	if (!row) throw notFound();
	await audit(
		auditContext(actor),
		"email_template.org_updated",
		{ type: "email_template", id: row.id },
		{ fieldCount: Object.keys(values).length },
	);
	return entryOf(row, "org");
}

export async function archiveOrgDefault(actor: TemplateActor, id: string): Promise<{ id: string }> {
	const organizationId = await requireOrgAdmin(actor.userId);
	const updated = await db
		.update(schema.emailTemplate)
		.set({ archivedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(schema.emailTemplate.organizationId, organizationId),
				eq(schema.emailTemplate.id, id),
				isNull(schema.emailTemplate.userId),
				isNull(schema.emailTemplate.archivedAt),
			),
		)
		.returning({ id: schema.emailTemplate.id });
	if (updated.length === 0) throw notFound();
	await audit(auditContext(actor), "email_template.org_archived", { type: "email_template", id });
	return { id };
}

// ---------------------------------------------------------------------------------------------------------------
// Filling a template in from an application

async function loadSource(userId: string, input: RenderInput): Promise<{ subject: string; body: string }> {
	if (isBuiltInId(input.templateId)) {
		const builtIn = builtInById(input.templateId);
		if (!builtIn) throw notFound();
		return input.source ?? { subject: builtIn.subject, body: builtIn.body };
	}
	// The text of a stored template is the stored text; a client cannot replace it.
	if (input.source)
		throw new ORPCError("BAD_REQUEST", { message: "Only a built-in template can be given a source text." });
	const [row] = await db
		.select({ subject: schema.emailTemplate.subject, body: schema.emailTemplate.body })
		.from(schema.emailTemplate)
		.where(
			and(
				eq(schema.emailTemplate.organizationId, requireOrgId()),
				eq(schema.emailTemplate.id, input.templateId),
				isNull(schema.emailTemplate.archivedAt),
				or(isNull(schema.emailTemplate.userId), eq(schema.emailTemplate.userId, userId)),
			),
		)
		.limit(1);
	if (!row) throw notFound();
	return row;
}

/** Subject and body of a template filled in from one of the caller's own applications. Nothing is stored or sent. */
export async function renderForApplication(userId: string, input: RenderInput) {
	const source = await loadSource(userId, input);
	// Another member's application is "not found", exactly like one that does not exist.
	const application = await applicationService.getById({ id: input.applicationId, userId });
	const [person] = await db
		.select({ name: schema.user.name, email: schema.user.email, timezone: schema.user.timezone })
		.from(schema.user)
		.where(eq(schema.user.id, userId))
		.limit(1);
	if (!person) throw new ORPCError("UNAUTHORIZED");

	const contact = pickContact(application.contacts);
	const interviewAt = pickInterviewDate(application.activity);
	const locale = (() => {
		try {
			return input.locale ? (Intl.getCanonicalLocales(input.locale)[0] ?? undefined) : undefined;
		} catch {
			return undefined;
		}
	})();
	const raw: TemplateValues = {
		firstName: firstNameOf(person.name),
		fullName: person.name,
		company: application.company,
		role: application.role,
		contactName: contact?.name,
		interviewDate: interviewAt ? formatInterview(interviewAt, locale, person.timezone) : undefined,
		myEmail: person.email,
	};
	const values = Object.fromEntries(
		Object.entries(raw).map(([name, value]) => [
			name,
			typeof value === "string" ? value.slice(0, MAX_VALUE_LENGTH) : value,
		]),
	) as TemplateValues;
	const missing = variablesIn(`${source.subject}\n${source.body}`).filter(
		(name: VariableName) => (values[name] ?? "").trim() === "",
	);
	return {
		subject: renderSubject(source.subject, values),
		body: renderTemplate(source.body, values),
		to: contact && isMailableAddress(contact.email) ? contact.email.trim() : null,
		missing,
	};
}
