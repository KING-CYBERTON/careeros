import { agentRouter } from "../features/agent/router";
import { aiProvidersRouter } from "../features/ai-providers/router";
import { aiUsageRouter } from "../features/ai-usage/router";
import { aiRouter } from "../features/ai/router";
import { applicationProfileRouter } from "../features/application-profile/router";
import { applicationsRouter } from "../features/applications/router";
import { authRouter } from "../features/auth/router";
// CAREEROS: billing for organization owners (P3-T04)
import { billingRouter } from "../features/billing/router";
// CAREEROS: organization branding and settings (P2-T01)
import { brandingRouter, settingsRouter } from "../features/branding/router";
import { careerRouter } from "../features/career/router";
import { coverLettersRouter } from "../features/cover-letters/router";
import { customDomainRouter } from "../features/custom-domain/router";
// CAREEROS: job discovery (P4-T01)
import { discoveryRouter } from "../features/discovery/router";
import { documentsRouter } from "../features/documents/router";
import { flagsRouter } from "../features/flags/router";
// CAREEROS: organization custom domains (P2-T06)
import { organizationDomainRouter } from "../features/org-domain/router";
// CAREEROS: join or switch page of an organization host (P2-T03)
import { organizationHostRouter } from "../features/organization-host/router";
// CAREEROS: read-only entitlements and audit log of the organization (P3-T01)
import { organizationRouter } from "../features/organization/router";
import { resumeRouter } from "../features/resume/router";
import { statisticsRouter } from "../features/statistics/router";
import { storageRouter } from "../features/storage/router";
import { webAccessRouter } from "../features/web-access/router";

export default {
	applicationProfile: applicationProfileRouter,
	ai: aiRouter,
	aiProviders: aiProvidersRouter,
	// CAREEROS (P3-T03): organization AI usage summary (owner or admin)
	aiUsage: aiUsageRouter,
	agent: agentRouter,
	applications: applicationsRouter,
	auth: authRouter,
	// CAREEROS: organization branding and settings (P2-T01)
	// CAREEROS: billing for organization owners (P3-T04)
	billing: billingRouter,
	branding: brandingRouter,
	career: careerRouter,
	coverLetters: coverLettersRouter,
	customDomain: customDomainRouter,
	// CAREEROS: job discovery (P4-T01)
	discovery: discoveryRouter,
	documents: documentsRouter,
	flags: flagsRouter,
	// CAREEROS: read-only entitlements and audit log of the organization (P3-T01)
	organization: organizationRouter,
	// CAREEROS: join or switch page of an organization host (P2-T03)
	organizationHost: organizationHostRouter,
	// CAREEROS: organization custom domains (P2-T06)
	organizationDomain: organizationDomainRouter,
	resume: resumeRouter,
	// CAREEROS: organization settings (P2-T01)
	settings: settingsRouter,
	statistics: statisticsRouter,
	storage: storageRouter,
	webAccess: webAccessRouter,
};
