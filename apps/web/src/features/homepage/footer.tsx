// CAREEROS: minimal landing footer. Links to the open-source licenses page, which keeps the MIT attribution visible.
// CAREEROS (P6-T01): the terms and privacy links are the organization's own when it set them, else the platform's pages.
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { resolveLegalLinks } from "@reactive-resume/utils/legal-links";
import { getBrand } from "@/libs/brand";

export function LandingFooter() {
	const brand = getBrand();
	const { privacy, terms } = resolveLegalLinks(brand);
	// The data processing addendum is between an organization and the platform, so only the platform's own pages show it.
	const showDpa = privacy.platform && terms.platform;

	return (
		<footer className="relative flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-6 py-8 text-sm text-ink-2">
			<span>© {brand.appName}</span>
			{privacy.platform ? (
				<Link to="/privacy" className="underline-offset-4 hover:underline">
					<Trans>Privacy policy</Trans>
				</Link>
			) : (
				<a href={privacy.href} className="underline-offset-4 hover:underline">
					<Trans>Privacy policy</Trans>
				</a>
			)}
			{terms.platform ? (
				<Link to="/terms" className="underline-offset-4 hover:underline">
					<Trans>Terms of service</Trans>
				</Link>
			) : (
				<a href={terms.href} className="underline-offset-4 hover:underline">
					<Trans>Terms of service</Trans>
				</a>
			)}
			{showDpa ? (
				<Link to="/dpa" className="underline-offset-4 hover:underline">
					<Trans>Data processing addendum</Trans>
				</Link>
			) : null}
			<Link to="/licenses" className="underline-offset-4 hover:underline">
				<Trans>Open-source licenses</Trans>
			</Link>
		</footer>
	);
}
