import type { BrandInfo } from "@reactive-resume/utils/brand";
import { useLingui } from "@lingui/react/macro";
import { Image } from "expo-image";
import { openBrowserAsync } from "expo-web-browser";
import { View } from "react-native";
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
};

export function PrivacyPolicyLink({ brand }: PrivacyPolicyLinkProps) {
	const { t } = useLingui();
	const current = useBrand();
	// CAREEROS: the link goes to the brand's privacy policy; with none set, the link is not shown (P2-T08).
	const { privacyUrl } = brand ?? current;
	if (!privacyUrl) return null;
	return (
		<View style={{ alignSelf: "center" }}>
			<Button
				label={t`Privacy policy`}
				variant="link"
				onPress={() => {
					void openBrowserAsync(privacyUrl).catch(() =>
						showToast({ message: t`Couldn't open the browser. Try again.` }),
					);
				}}
			/>
		</View>
	);
}

/** The host of an origin, as people type it: `https://example.com` → `example.com`. */
export const hostOf = (origin: string) => origin.replace(/^https?:\/\//, "");
