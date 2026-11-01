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
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";

// ponytail: server dev consumes this source through tsx, which emits React.createElement here.
void React;

// CAREEROS: every template takes the product name (and an absolute logo URL, when the brand has one) as optional
// props and falls back to the platform default (P2-T08). Callers pass the org brand once P2-T02 lands.
type EmailBrandProps = {
	appName?: string | undefined;
	logoUrl?: string | undefined;
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
	appName = PLATFORM_DEFAULT_APP_NAME,
	logoUrl,
}: AuthEmailLayoutProps) {
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

export function ResetPasswordEmail({ url, appName = PLATFORM_DEFAULT_APP_NAME, logoUrl }: ResetPasswordEmailProps) {
	return (
		<AuthEmailLayout
			appName={appName}
			logoUrl={logoUrl}
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

export function VerifyEmail({ url, appName = PLATFORM_DEFAULT_APP_NAME, logoUrl }: VerifyEmailProps) {
	return (
		<AuthEmailLayout
			appName={appName}
			logoUrl={logoUrl}
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

export function VerifyEmailChange({
	url,
	previousEmail,
	newEmail,
	appName = PLATFORM_DEFAULT_APP_NAME,
	logoUrl,
}: VerifyEmailChangeProps) {
	return (
		<AuthEmailLayout
			appName={appName}
			logoUrl={logoUrl}
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

export function InvitationEmail({
	url,
	organizationName,
	inviterName,
	appName = PLATFORM_DEFAULT_APP_NAME,
	logoUrl,
}: InvitationEmailProps) {
	return (
		<AuthEmailLayout
			appName={appName}
			logoUrl={logoUrl}
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
