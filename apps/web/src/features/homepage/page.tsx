// CAREEROS: the upstream marketing homepage is replaced by a minimal neutral landing page (P2-T08).
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@reactive-resume/ui/components/button";
import { LandingBackground } from "./background";
import { LandingFooter } from "./footer";
import { getBrand } from "@/libs/brand";

/** The public landing page: the app name, one line of copy, and the sign-in and registration buttons. */
export function Homepage() {
	const { appName } = getBrand();

	return (
		<div className="landing relative isolate flex min-h-svh flex-col bg-bg font-ui text-ink">
			<LandingBackground />
			<a
				href="#main"
				className="fixed start-4 top-2.5 z-100 -translate-y-[160%] rounded-md bg-ink px-3.5 py-2.5 font-ui text-sm font-semibold text-bg transition-transform focus:translate-y-0"
			>
				{t`Skip to content`}
			</a>
			<main id="main" className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
				<h1 className="font-display text-5xl font-semibold tracking-tight text-balance sm:text-6xl">{appName}</h1>
				<p className="text-lg text-pretty text-ink-2 sm:text-xl">
					<Trans>Your career workspace</Trans>
				</p>
				{/* Plain links styled as buttons, so they keep the link role for assistive tech and tests. */}
				<div className="flex flex-wrap items-center justify-center gap-3">
					<Link to="/auth/login" className={buttonVariants({ size: "lg" })}>
						<Trans>Sign in</Trans>
					</Link>
					<Link to="/auth/register" className={buttonVariants({ size: "lg", variant: "secondary" })}>
						<Trans>Create account</Trans>
					</Link>
				</div>
			</main>
			<LandingFooter />
		</div>
	);
}
