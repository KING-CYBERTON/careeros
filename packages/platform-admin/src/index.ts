// CAREEROS (P3-T07, phase plan D6, D7): the Super Admin console's database access and rules. Every cross-organization
// action is a SECURITY DEFINER function that checks the actor in the database and audits in the same transaction.
export {
	assertPlatformAdmin,
	getMetrics,
	getOrg,
	listAudit,
	listOrgs,
	recordManualPayment,
	setAiOverage,
	setOrgPlan,
	setOrgStatus,
	type AdminAuditEntry,
	type AdminMetrics,
	type AdminOrgDetail,
	type AdminOrgSummary,
	type AuditFilters,
	type ManualPaymentInput,
	type OrgListFilters,
} from "./admin";
export {
	activeAnnouncementsForMember,
	dismissAnnouncement,
	endAnnouncement,
	listAnnouncements,
	saveAnnouncement,
	type AdminAnnouncement,
	type AnnouncementInput,
	type AnnouncementSeverity,
	type MemberAnnouncement,
} from "./announcements";
export { AdminError, databaseMessage, guarded, toAdminError, type AdminErrorCode } from "./errors";
export {
	attachImpersonationSession,
	endImpersonation,
	expireDueImpersonations,
	getImpersonationForSession,
	isImpersonationActive,
	isImpersonationToken,
	redeemImpersonation,
	startImpersonation,
	type ImpersonationBanner,
	type RedeemedImpersonation,
	type StartedImpersonation,
	type StartImpersonationInput,
} from "./impersonation";
export {
	DISABLED_ADMIN_AUTH_PATHS,
	hasPlatformAdminRole,
	IMPERSONATION_MAX_MS,
	IMPERSONATION_MINUTES,
	IMPERSONATION_REFUSED_AUTH_PATHS,
	IMPERSONATION_REFUSED_AUTH_PREFIXES,
	IMPERSONATION_REFUSED_PREFIXES,
	IMPERSONATION_REFUSED_PROCEDURES,
	IMPERSONATION_TOKEN_SECONDS,
	isAuthPathRefusedWhileImpersonating,
	isRefusedWhileImpersonating,
} from "./policy";
