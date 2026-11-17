import type { IconName } from "@reactive-resume/ui/components/icon";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Fragment } from "react";
import { Icon } from "@reactive-resume/ui/components/icon";
// CAREEROS (P3-T08)
import { useOrgAdminAccess } from "@/features/org-admin/queries";
// CAREEROS: Members & invites entry for owners and admins (P1-T03)
import { useCanManageMembers } from "@/features/organization/queries";
import { popTransition } from "@/features/settings/root";
import { getBrand } from "@/libs/brand";

type Page = {
	// CAREEROS: members route added (P1-T03)
	to:
		| "/dashboard/settings/account"
		| "/dashboard/settings/preferences"
		| "/dashboard/settings/ai"
		| "/dashboard/settings/members"
		// CAREEROS (P2-T07)
		| "/dashboard/settings/branding"
		| "/dashboard/settings/domains"
		// CAREEROS (P3-T08)
		| "/dashboard/settings/cohorts"
		| "/dashboard/settings/analytics"
		| "/dashboard/settings/ai-usage"
		| "/dashboard/settings/audit"
		// CAREEROS (P5-T04)
		| "/dashboard/settings/email-templates"
		| "/dashboard/settings/org-email-templates"
		// CAREEROS (P3-T06)
		| "/dashboard/organization/billing";
	icon: IconName;
	label: () => string;
};

// Six pages became three, each with one job (README §5.9).
const SETTINGS_PAGES: Page[] = [
	{ to: "/dashboard/settings/account", icon: "user-circle", label: () => t`Account` },
	{ to: "/dashboard/settings/preferences", icon: "sliders-horizontal", label: () => t`Preferences` },
	{ to: "/dashboard/settings/ai", icon: "sparkle", label: () => t`AI & developer` },
	// CAREEROS (P5-T04): every member writes to employers from templates
	{ to: "/dashboard/settings/email-templates", icon: "envelope-simple", label: () => t`Email templates` },
];

// CAREEROS: shown to owners and admins only; the server enforces the same rule (P1-T03)
const MEMBERS_PAGE: Page = { to: "/dashboard/settings/members", icon: "user-plus", label: () => t`Members & invites` };

// CAREEROS (P2-T07): branding and domains, for owners and admins only; the API enforces the same rule
const BRANDING_PAGES: Page[] = [
	{ to: "/dashboard/settings/branding", icon: "palette", label: () => t`Branding` },
	{ to: "/dashboard/settings/domains", icon: "globe", label: () => t`Domains` },
];

// CAREEROS (P3-T08): the Org Admin pages. Shown to owners and admins of an organization (not a personal workspace);
// each page and the API check the same rule.
const ORG_ADMIN_PAGES: Page[] = [
	{ to: "/dashboard/settings/cohorts", icon: "graduation-cap", label: () => t`Cohorts` },
	{ to: "/dashboard/settings/analytics", icon: "chart-line-up", label: () => t`Analytics` },
	{ to: "/dashboard/settings/ai-usage", icon: "sparkle", label: () => t`AI usage` },
	{ to: "/dashboard/settings/audit", icon: "list-checks", label: () => t`Audit log` },
	// CAREEROS (P5-T04): the templates every member of the organization sees
	{ to: "/dashboard/settings/org-email-templates", icon: "file-text", label: () => t`Org email templates` },
];

// CAREEROS (P3-T06): billing, for owners and admins (the page and the API check again; only the owner can act)
const BILLING_PAGE: Page = { to: "/dashboard/organization/billing", icon: "briefcase", label: () => t`Billing` };

// CAREEROS: the upstream project links (docs, source, translation, bug tracker, donations) are gone. What remains is the
// licenses page and, when the brand sets one, a support link.
const getProjectLinks = () => {
	const { supportUrl } = getBrand();
	return supportUrl ? [{ href: supportUrl, label: t`Support` }] : [];
};

export const Route = createFileRoute("/dashboard/settings")({ component: RouteComponent });

function RouteComponent() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const isRoot = pathname.replace(/\/$/, "") === "/dashboard/settings";
	// CAREEROS (P1-T03, P2-T07)
	const orgAdmin = useOrgAdminAccess() === "allowed";
	const pages = useCanManageMembers()
		? [...SETTINGS_PAGES, MEMBERS_PAGE, ...BRANDING_PAGES, BILLING_PAGE, ...(orgAdmin ? ORG_ADMIN_PAGES : [])]
		: SETTINGS_PAGES;

	return (
		<div className="grid min-h-full content-start sm:h-svh sm:min-h-0 sm:grid-rows-[auto_minmax(0,1fr)] sm:overflow-hidden lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 lg:content-stretch">
			<nav
				aria-label={t`Settings`}
				className="flex flex-col gap-1 border-line [view-transition-name:settings-nav] max-lg:border-b max-sm:hidden lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:border-e lg:py-7 lg:ps-6 lg:pe-3"
			>
				<div className="flex gap-1 max-lg:overflow-x-auto max-lg:px-6 max-lg:py-2 lg:flex-col">
					{pages.map((page) => (
						<Link
							key={page.to}
							to={page.to}
							className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-ink-2 transition-colors duration-quick hover:bg-hover"
							activeProps={{ className: "bg-sunken text-ink", "aria-current": "page" }}
						>
							<Icon name={page.icon} size={20} />
							{page.label()}
						</Link>
					))}
				</div>
				<p className="mt-auto px-2.5 text-xs leading-[18px] text-ink-3 max-lg:hidden">
					{getBrand().appName} {__APP_VERSION__}
					<br />
					<Link className="underline" to="/licenses">
						<Trans>Open-source licenses</Trans>
					</Link>
					{getProjectLinks().map((link) => (
						<Fragment key={link.href}>
							{" · "}
							<a className="underline" href={link.href} target="_blank" rel="noopener noreferrer">
								{link.label}
							</a>
						</Fragment>
					))}
				</p>
			</nav>

			<div className="min-w-0 px-12 pt-8 pb-16 max-lg:px-6 max-sm:px-4 max-sm:pt-4 sm:min-h-0 sm:overflow-y-auto sm:overscroll-contain">
				{!isRoot && (
					<Link
						to="/dashboard/settings"
						viewTransition={popTransition}
						className="mb-4 inline-flex h-9 items-center gap-1 text-sm text-ink-2 sm:hidden"
					>
						<Icon name="caret-left" size={20} />
						<Trans>Settings</Trans>
					</Link>
				)}
				<div className="grid max-w-[680px] gap-8">
					<Outlet />
				</div>
			</div>
		</div>
	);
}
