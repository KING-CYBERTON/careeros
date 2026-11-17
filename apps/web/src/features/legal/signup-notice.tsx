// CAREEROS (P6-T01, G10): "By creating an account you agree to the Terms and the Privacy policy", under the sign-up form.
// An organization's own terms and privacy links win; otherwise the platform's pages are linked.
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { resolveLegalLinks, type LegalLink } from "@reactive-resume/utils/legal-links";
import { getBrand } from "@/libs/brand";

type LegalAnchorProps = {
	link: LegalLink;
	to: "/terms" | "/privacy";
	children: string;
};

function LegalAnchor({ link, to, children }: LegalAnchorProps) {
	const className = "underline underline-offset-4 hover:text-ink";
	if (link.platform)
		return (
			<Link to={to} className={className}>
				{children}
			</Link>
		);
	return (
		<a href={link.href} className={className} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}

export function SignupLegalNotice() {
	const { terms, privacy } = resolveLegalLinks(getBrand());

	return (
		<p className="text-center text-sm text-ink-3" data-testid="signup-legal-notice">
			<Trans>
				By creating an account you agree to the{" "}
				<LegalAnchor link={terms} to="/terms">
					Terms
				</LegalAnchor>{" "}
				and the{" "}
				<LegalAnchor link={privacy} to="/privacy">
					Privacy policy
				</LegalAnchor>
				.
			</Trans>
		</p>
	);
}
