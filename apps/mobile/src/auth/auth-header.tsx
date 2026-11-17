import type { BrandInfo } from "@reactive-resume/utils/brand";
import { useLingui } from "@lingui/react/macro";
import { Image } from "expo-image";
import { openBrowserAsync } from "expo-web-browser";
import { View } from "react-native";
import { resolveLegalLinks } from "@reactive-resume/utils/legal-links";
import { useBrand } from "@/branding/store";
import { Button, Text, showToast, useTheme } from "@/ui";

type AuthHeaderProps = {
	subtitle?: string | undefined;
	/** CAREEROS (P2-T02): the brand to show; the app's current one when absent. */
	brand?: BrandInfo | undefined;
};

/** The app mark and name at the top of the sign-in screens. */
export function AuthHeader({ subtitle, brand }: AuthHeaderProps) {
	const { radius, space } = useTheme();
	const current = useBrand();
	const { appName, logoUrl } = brand ?? current;

	return (
		<View style={{ alignItems: "center", gap: space.s4, paddingHorizontal: space.s2 }}>
			<Image
				// CAREEROS (P2-T02): the organization's logo when it has one; the store listing and app icon stay as shipped.
				source={logoUrl ? { uri: logoUrl } : require("../../assets/icon.png")}
				contentFit="contain"
				accessible={false}
				style={{
					width: space.s12 * 2,
					height: space.s12 * 2,
					borderRadius: radius.rLg,
					marginBottom: space.s2,
				}}
			/>
			<Text variant="display" align="center" accessibilityRole="header">
				{appName}
			</Text>
			{subtitle ? (
				<Text color="ink2" align="center">
					{subtitle}
				</Text>
			) : null}
		</View>
	);
}

type PrivacyPolicyLinkProps = {
	/** CAREEROS (P2-T02): the brand whose policy is linked; the app's current one when absent. */
	brand?: BrandInfo | undefined;
	/** CAREEROS (P6-T01): the server the platform's pages are on, when the brand has no policy of its own. */
	server: string;
};

function useOpenLink() {
	const { t } = useLingui();
	return (url: string) => {
		void openBrowserAsync(url).catch(() => showToast({ message: t`Couldn't open the browser. Try again.` }));
	};
}

export function PrivacyPolicyLink({ brand, server }: PrivacyPolicyLinkProps) {
	const { t } = useLingui();
	const current = useBrand();
	const openLink = useOpenLink();
	// CAREEROS (P6-T01): the brand's own privacy policy, else the server's /privacy page (P2-T08 hid the link instead).
	const { privacy } = resolveLegalLinks(brand ?? current, server);
	return (
		<View style={{ alignSelf: "center" }}>
			<Button label={t`Privacy policy`} variant="link" onPress={() => openLink(privacy.href)} />
		</View>
	);
}

/** CAREEROS (P6-T01): "By creating an account you agree to the Terms and the Privacy policy", with both pages linked. */
export function SignUpLegalNotice({ brand, server }: PrivacyPolicyLinkProps) {
	const { t } = useLingui();
	const { space } = useTheme();
	const current = useBrand();
	const openLink = useOpenLink();
	const { terms, privacy } = resolveLegalLinks(brand ?? current, server);
	return (
		<View style={{ alignItems: "center", gap: space.s1 }}>
			<Text variant="callout" color="ink3" align="center">
				{t`By creating an account you agree to the Terms and the Privacy policy.`}
			</Text>
			<View style={{ flexDirection: "row", justifyContent: "center", gap: space.s2 }}>
				<Button label={t`Terms`} variant="link" onPress={() => openLink(terms.href)} />
				<Button label={t`Privacy policy`} variant="link" onPress={() => openLink(privacy.href)} />
			</View>
		</View>
	);
}

/** The host of an origin, as people type it: `https://example.com` → `example.com`. */
export const hostOf = (origin: string) => origin.replace(/^https?:\/\//, "");
