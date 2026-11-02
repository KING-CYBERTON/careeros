import { useLingui } from "@lingui/react/macro";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { View } from "react-native";
// CAREEROS (P2-T02): the brand follows the organization the server belongs to
import { useBrand } from "@/branding/store";
// CAREEROS (P2-T07): Branding and Domains rows for owners and admins
import { useOrganizationAdmin } from "@/features/branding/access";
import { SettingsGroup, SettingsPage } from "@/features/settings/layout";
import { useProfile } from "@/features/settings/queries";
import { SignOutRow } from "@/features/settings/sign-out";
import { routes } from "@/routes";
import { Avatar, ListRow, Text, showToast, useTheme, useThemePreference } from "@/ui";

export default function SettingsScreen() {
	const router = useRouter();
	const { t } = useLingui();
	const { space } = useTheme();
	const profile = useProfile();
	const { appName, supportUrl, privacyUrl, termsUrl } = useBrand();
	const openLink = (url: string) => {
		void openBrowserAsync(url).catch(() => showToast({ message: t`Couldn't open the browser. Try again.` }));
	};
	const canManageBrand = useOrganizationAdmin() === "allowed";
	const theme = useThemePreference();
	const appearance = { system: t`System`, light: t`Light`, dark: t`Dark` }[theme];
	return (
		<SettingsPage onRefresh={profile.refetch} title={t`Settings`} root>
			<SettingsGroup>
				<ListRow
					title={profile.data?.name ?? t`Account`}
					subtitle={profile.data?.email}
					leading={<Avatar name={profile.data?.name ?? t`Account`} uri={profile.data?.image} />}
					chevron
					onPress={() => router.push(routes.settings("account"))}
				/>
			</SettingsGroup>
			<SettingsGroup>
				<ListRow
					title={t`Preferences`}
					leading="circle-half"
					value={appearance}
					chevron
					onPress={() => router.push(routes.settings("preferences"))}
				/>
				<ListRow title={t`AI & developer`} leading="robot" chevron onPress={() => router.push(routes.settings("ai"))} />
			</SettingsGroup>
			{/* CAREEROS (P2-T07): shown to owners and admins only; the API enforces the same rule. */}
			{canManageBrand ? (
				<SettingsGroup title={t`Organization`}>
					<ListRow
						title={t`Branding`}
						leading="palette"
						chevron
						onPress={() => router.push(routes.settings("branding"))}
					/>
					<ListRow title={t`Domains`} leading="globe" chevron onPress={() => router.push(routes.settings("domains"))} />
				</SettingsGroup>
			) : null}
			<SettingsGroup>
				<SignOutRow switchServer />
			</SettingsGroup>
			{/* CAREEROS: the upstream support, community, source and donation rows were removed (P2-T08). */}
			{supportUrl ? (
				<SettingsGroup title={t`Support`}>
					<ListRow title={t`Help & docs`} leading="question" external onPress={() => openLink(supportUrl)} />
				</SettingsGroup>
			) : null}
			<SettingsGroup title={t`Legal`}>
				{privacyUrl ? (
					<ListRow title={t`Privacy policy`} leading="shield-check" external onPress={() => openLink(privacyUrl)} />
				) : null}
				{termsUrl ? (
					<ListRow title={t`Terms of service`} leading="scroll" external onPress={() => openLink(termsUrl)} />
				) : null}
				<ListRow
					title={t`Open-source licenses`}
					leading="file-text"
					chevron
					onPress={() => router.push("/(tabs)/settings/licences")}
				/>
			</SettingsGroup>
			<SettingsGroup>
				<SignOutRow />
			</SettingsGroup>
			<View style={{ alignItems: "center", gap: space.s1 }}>
				<Text variant="caption" color="ink3" align="center">
					{appName}
				</Text>
				<Text variant="caption" color="ink3" align="center">
					v{Constants.expoConfig?.version ?? "—"}
				</Text>
			</View>
		</SettingsPage>
	);
}
