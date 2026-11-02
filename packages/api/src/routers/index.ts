import { agentRouter } from "../features/agent/router";
import { aiProvidersRouter } from "../features/ai-providers/router";
import { aiRouter } from "../features/ai/router";
import { applicationProfileRouter } from "../features/application-profile/router";
import { applicationsRouter } from "../features/applications/router";
import { authRouter } from "../features/auth/router";
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
import { resumeRouter } from "../features/resume/router";
import { statisticsRouter } from "../features/statistics/router";
import { storageRouter } from "../features/storage/router";
import { webAccessRouter } from "../features/web-access/router";

export default {
	applicationProfile: applicationProfileRouter,
	ai: aiRouter,
	aiProviders: aiProvidersRouter,
	agent: agentRouter,
	applications: applicationsRouter,
	auth: authRouter,
	// CAREEROS: organization branding and settings (P2-T01)
	branding: brandingRouter,
	career: careerRouter,
	coverLetters: coverLettersRouter,
	customDomain: customDomainRouter,
	// CAREEROS: job discovery (P4-T01)
	discovery: discoveryRouter,
	documents: documentsRouter,
	flags: flagsRouter,
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
