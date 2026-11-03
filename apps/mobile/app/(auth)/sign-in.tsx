import type { BrandInfo } from "@reactive-resume/utils/brand";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ObserveInteractiveMarker } from "expo-observe";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { AuthHeader, PrivacyPolicyLink, SignUpLegalNotice, hostOf } from "@/auth/auth-header";
import { getFlags, isAllowedServer, toOrigin } from "@/auth/oauth";
import { useSession } from "@/auth/session";
import { useSignIn } from "@/auth/use-sign-in";
// CAREEROS (P2-T02): the organization's name, logo and link, as last seen on this server
import { useHostBranding } from "@/branding/host";
import { useStoredBrand } from "@/branding/store";
import { routes } from "@/routes";
import { Banner, Button, Card, ListRow, Screen, Text, useTheme } from "@/ui";

/** The server from the picker (`?server=`), else the current one. Only servers `isAllowedServer` accepts. */
function useTargetServer(): string {
	const { server: current } = useSession();
	const { server } = useLocalSearchParams<{ server?: string }>();
	const origin = server ? toOrigin(server) : null;
	return origin && isAllowedServer(origin) ? origin : current;
}

/** AU4 sign-in landing, AU5 waiting for the browser, AU6 sign-ups disabled, AU9 sign-in didn't complete. */
export default function SignInScreen() {
	const router = useRouter();
	const { t } = useLingui();
	const { size, space } = useTheme();
	const server = useTargetServer();
	const host = hostOf(server);
	// CAREEROS (P2-T07, Q95): ask the server which organization this address belongs to, so a first sign-in is branded too
	useHostBranding(server);
	const brand = useStoredBrand(server);
	const { attempt, start, cancel, reset } = useSignIn();
	const flags = useQuery({ queryKey: ["auth", "flags", server], queryFn: () => getFlags(server) });

	const changeServer = () => router.push(routes.server());

	return (
		<Screen
			scroll={false}
			edges={["top", "bottom"]}
			contentStyle={{ width: "100%", maxWidth: size.panel, alignSelf: "center" }}
		>
			<ObserveInteractiveMarker />
			<ScrollView
				style={{ flex: 1 }}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{ flexGrow: 1, justifyContent: "center", gap: space.s8, paddingVertical: space.s8 }}
			>
				{attempt.state === "waiting" ? (
					<Waiting onCancel={cancel} brand={brand} />
				) : attempt.state === "failed" ? (
					<>
						<AuthHeader brand={brand} />
						<View style={{ gap: space.s3 }}>
							<Banner
								tone="danger"
								icon="warning-circle"
								title={t`Sign-in didn't complete`}
								message={attempt.message}
							/>
							<Button
								label={t`Try again in browser`}
								icon="arrow-square-out"
								size="lg"
								fullWidth
								onPress={() => void start(server)}
							/>
							<Button label={t`Back to sign in`} variant="ghost" size="lg" fullWidth onPress={reset} />
						</View>
					</>
				) : (
					<>
						<AuthHeader brand={brand} subtitle={t`Your resumes, letters and applications, on ${host}.`} />
						<View style={{ gap: space.s3 }}>
							{flags.data?.disableSignups ? (
								<Banner
									tone="info"
									icon="info"
									title={t`New account sign-ups are currently disabled on this server.`}
									message={t`You can sign in with an account you already have.`}
								/>
							) : null}
							<Button
								label={t`Continue in browser`}
								icon="arrow-square-out"
								size="lg"
								fullWidth
								onPress={() => void start(server)}
							/>
							{/* The browser's sign-in page offers the guest account; the app cannot create one itself. */}
							{flags.data?.allowGuestLogin ? (
								<Button
									label={t`Continue as guest`}
									variant="secondary"
									size="lg"
									fullWidth
									onPress={() => void start(server)}
								/>
							) : null}
							{flags.data?.disableSignups ? null : (
								<>
									<Text variant="callout" color="ink3" align="center">
										{t`Sign in or create an account in the browser, with email, a passkey, Google, GitHub or LinkedIn. You come back here when you're done.`}
									</Text>
									{/* CAREEROS (P6-T01): sign-up consent notice with links to the terms and privacy policy. */}
									<SignUpLegalNotice brand={brand} server={server} />
								</>
							)}
						</View>
					</>
				)}
			</ScrollView>
			{attempt.state === "idle" ? (
				<Card style={{ padding: 0, overflow: "hidden" }}>
					<ListRow
						title={host}
						subtitle={t`Server`}
						leading="globe-simple"
						trailing={
							<Text variant="callout" color="ink3">
								{t`Change`}
							</Text>
						}
						chevron
						onPress={changeServer}
					/>
				</Card>
			) : null}
			<PrivacyPolicyLink brand={brand} server={server} />
		</Screen>
	);
}

type WaitingProps = {
	onCancel: () => void;
	brand: BrandInfo;
};

function Waiting({ onCancel, brand }: WaitingProps) {
	const { t } = useLingui();
	const { colors, space } = useTheme();

	return (
		<>
			<AuthHeader brand={brand} />
			<View style={{ gap: space.s4, alignItems: "center", paddingHorizontal: space.s2 }}>
				<ActivityIndicator size="large" color={colors.accent} />
				<Text variant="heading" align="center">{t`Finish signing in in the browser`}</Text>
				<Text color="ink2" align="center">{t`When you're done, the browser closes and you come back here.`}</Text>
				<View style={{ alignSelf: "center" }}>
					<Button label={t`Cancel`} variant="secondary" onPress={onCancel} />
				</View>
			</View>
		</>
	);
}
