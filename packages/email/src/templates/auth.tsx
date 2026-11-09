import type { RenewalReminderCopy } from "../billing-strings";
import type { EmailBrand } from "../brand";
import * as React from "react";
import {
	Body,
	Button,
	Container,
	Font,
	Head,
	Heading,
	Hr,
	Html,
	Img,
	Link,
	Preview,
	pixelBasedPreset,
	Section,
	Tailwind,
	Text,
} from "react-email";
import { resolveEmailBrand } from "../brand";

// ponytail: server dev consumes this source through tsx, which emits React.createElement here.
void React;

// CAREEROS: every template takes the organization's brand as one optional `brand` prop and falls back to the platform
// default (P2-T08, P2-T04). The brand is checked again here (`resolveEmailBrand`) before it reaches a style or a link.
type EmailBrandProps = {
	brand?: EmailBrand | undefined;
};

interface AuthEmailLayoutProps extends EmailBrandProps {
	preview: string;
	heading: string;
	intro: string;
	details?: string;
	actionLabel: string;
	actionUrl: string;
	outro: string;
}

function AuthEmailLayout({
	preview,
	heading,
	intro,
	details,
	actionLabel,
	actionUrl,
	outro,
	brand,
}: AuthEmailLayoutProps) {
	const { appName, logoUrl, primaryColor, primaryForeground, links } = resolveEmailBrand(brand);
	return (
		<Html lang="en">
			<Tailwind
				config={{
					presets: [pixelBasedPreset],
					theme: {
						fontFamily: {
							body: ["IBM Plex Sans", "sans-serif"],
							heading: ["IBM Plex Sans Condensed", "sans-serif"],
						},
					},
				}}
			>
				<Head>
					<Font
						fontFamily="IBM Plex Sans Condensed"
						fallbackFontFamily="sans-serif"
						fontWeight={500}
						fontStyle="normal"
						webFont={{
							url: "https://fonts.gstatic.com/s/ibmplexsans/v23/zYXGKVElMYYaJe8bpLHnCwDKr932-G7dytD-DmvrswZSAXcomDVmadSD2FlDB6g4tIOm6_De.woff2",
							format: "woff2",
						}}
					/>
					<Font
						fontFamily="IBM Plex Sans"
						fallbackFontFamily="sans-serif"
						fontWeight={400}
						fontStyle="normal"
						webFont={{
							url: "https://fonts.gstatic.com/s/ibmplexsans/v23/zYXGKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1swZSAXcomDVmadSD6llDB6g4tIOm6_De.woff2",
							format: "woff2",
						}}
					/>
				</Head>

				<Body className="font-body m-0 bg-zinc-950 p-0 text-sm text-zinc-50">
					<Preview>{preview}</Preview>
					<Container className="mx-auto w-full max-w-xl bg-zinc-900 p-6 text-zinc-50">
						<Section>
							{logoUrl ? (
								<Img src={logoUrl} alt={appName} width="48" height="48" className="block" />
							) : (
								<Text className="font-heading m-0 text-base font-medium tracking-tight">{appName}</Text>
							)}
						</Section>

						<Section className="mt-6">
							<Heading className="font-heading text-2xl leading-0 font-medium tracking-tighter whitespace-break-spaces md:text-5xl">
								{heading}
							</Heading>

							<Section className="mt-6 md:mt-12">
								<Text>{intro}</Text>

								{details ? <Text className="opacity-60">{details}</Text> : null}
							</Section>

							<Button
								target="_blank"
								href={actionUrl}
								className="mt-6 box-border inline-block bg-zinc-200 px-6 py-3 text-center text-zinc-900 no-underline"
								// CAREEROS (P2-T04): the organization's primary colour, with the readable text colour on it.
								style={primaryColor ? { backgroundColor: primaryColor, color: primaryForeground } : undefined}
							>
								{actionLabel}
							</Button>

							<Section className="mt-8">
								<Text className="leading-0">
									If the button does not work, copy and paste this link into your browser:
								</Text>
								<Link className="leading-0 text-zinc-200/60 underline underline-offset-2" href={actionUrl}>
									{actionUrl}
								</Link>
							</Section>

							<Section className="mt-4">
								<Text className="opacity-60">{outro}</Text>
							</Section>

							<Hr className="my-10 border-zinc-700" />

							<Text className="font-heading mt-8 text-base font-medium tracking-tight opacity-80">{appName}</Text>

							{links.length > 0 ? (
								<Text className="mt-0 text-xs opacity-60">
									{links.map(({ label, url }, index) => (
										<React.Fragment key={label}>
											{index > 0 ? " · " : null}
											<Link className="text-zinc-50 underline" href={url}>
												{label}
											</Link>
										</React.Fragment>
									))}
								</Text>
							) : null}
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}

interface ResetPasswordEmailProps extends EmailBrandProps {
	url: string;
}

export function ResetPasswordEmail({ url, brand }: ResetPasswordEmailProps) {
	const { appName } = resolveEmailBrand(brand);
	return (
		<AuthEmailLayout
			brand={brand}
			preview={`Reset your ${appName} password`}
			heading="Reset your password"
			intro={`We received a request to reset your ${appName} password.`}
			details="If this was not you, you can ignore this message and your password will remain unchanged."
			actionLabel="Create new password"
			actionUrl={url}
			outro={`For security, only use links from emails sent by ${appName}.`}
		/>
	);
}

interface VerifyEmailProps extends EmailBrandProps {
	url: string;
}

export function VerifyEmail({ url, brand }: VerifyEmailProps) {
	const { appName } = resolveEmailBrand(brand);
	return (
		<AuthEmailLayout
			brand={brand}
			preview={`Verify your email for ${appName}`}
			heading="Verify your email"
			intro={`Thanks for signing up for ${appName}. Verify your email address to continue.`}
			details="This confirms the address belongs to you, which keeps your account secure."
			actionLabel="Verify email"
			actionUrl={url}
			outro="If you did not create this account, you can safely ignore this email."
		/>
	);
}

interface VerifyEmailChangeProps extends EmailBrandProps {
	url: string;
	previousEmail: string;
	newEmail: string;
}

export function VerifyEmailChange({ url, previousEmail, newEmail, brand }: VerifyEmailChangeProps) {
	const { appName } = resolveEmailBrand(brand);
	return (
		<AuthEmailLayout
			brand={brand}
			preview={`Approve changing your ${appName} email address`}
			heading="Approve email change"
			intro={`Someone asked to change your ${appName} email from ${previousEmail} to ${newEmail}.`}
			details={`If you approve, we'll send a link to ${newEmail} to finish the change.`}
			actionLabel="Approve change"
			actionUrl={url}
			outro="If you did not request this change, ignore this email and change your password. The address on the account will not change without your approval."
		/>
	);
}

// CAREEROS: organization invitation email for the Better Auth organization plugin (P1-T01)
interface InvitationEmailProps extends EmailBrandProps {
	url: string;
	organizationName: string;
	inviterName: string;
}

export function InvitationEmail({ url, organizationName, inviterName, brand }: InvitationEmailProps) {
	const { appName } = resolveEmailBrand(brand);
	return (
		<AuthEmailLayout
			brand={brand}
			preview={`Join ${organizationName} on ${appName}`}
			heading="You have been invited"
			intro={`${inviterName} invited you to join ${organizationName} on ${appName}.`}
			details="The invitation expires in 7 days."
			actionLabel="Accept invitation"
			actionUrl={url}
			outro="If you were not expecting this invitation, you can safely ignore this email."
		/>
	);
}

// CAREEROS (P3-T05): the reminder an organization owner gets when a plan paid by M-Pesa is about to end. The words come
// from `renewalReminderCopy` (billing-strings.ts); `copy` is built by the sender so the subject and the body agree.
interface RenewalReminderEmailProps extends EmailBrandProps {
	url: string;
	copy: RenewalReminderCopy;
}

export function RenewalReminderEmail({ url, copy, brand }: RenewalReminderEmailProps) {
	return (
		<AuthEmailLayout
			brand={brand}
			preview={copy.preview}
			heading={copy.heading}
			intro={copy.intro}
			details={copy.details}
			actionLabel={copy.actionLabel}
			actionUrl={url}
			outro={copy.outro}
		/>
	);
}
