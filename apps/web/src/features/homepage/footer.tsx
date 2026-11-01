// CAREEROS: minimal landing footer. Links to the open-source licenses page, which keeps the MIT attribution visible.
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { getBrand } from "@/libs/brand";

export function LandingFooter() {
	const { appName, privacyUrl, termsUrl } = getBrand();

	return (
		<footer className="relative flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-6 py-8 text-sm text-ink-2">
			<span>© {appName}</span>
			{privacyUrl ? (
				<a href={privacyUrl} className="underline-offset-4 hover:underline">
					<Trans>Privacy policy</Trans>
				</a>
			) : null}
			{termsUrl ? (
				<a href={termsUrl} className="underline-offset-4 hover:underline">
					<Trans>Terms of service</Trans>
				</a>
			) : null}
			<Link to="/licenses" className="underline-offset-4 hover:underline">
				<Trans>Open-source licenses</Trans>
			</Link>
		</footer>
	);
}
