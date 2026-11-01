import { useLingui } from "@lingui/react/macro";
import { Image } from "expo-image";
import { openBrowserAsync } from "expo-web-browser";
import { View } from "react-native";
import { getBrand } from "@reactive-resume/utils/brand";
import { Button, Text, showToast, useTheme } from "@/ui";

type AuthHeaderProps = {
	subtitle?: string | undefined;
};

/** The app mark and name at the top of the sign-in screens. */
export function AuthHeader({ subtitle }: AuthHeaderProps) {
	const { radius, space } = useTheme();

	return (
		<View style={{ alignItems: "center", gap: space.s4, paddingHorizontal: space.s2 }}>
			<Image
				source={require("../../assets/icon.png")}
				accessible={false}
				style={{
					width: space.s12 * 2,
					height: space.s12 * 2,
					borderRadius: radius.rLg,
					marginBottom: space.s2,
				}}
			/>
			<Text variant="display" align="center" accessibilityRole="header">
				{getBrand().appName}
			</Text>
			{subtitle ? (
				<Text color="ink2" align="center">
					{subtitle}
				</Text>
			) : null}
		</View>
	);
}

export function PrivacyPolicyLink() {
	const { t } = useLingui();
	// CAREEROS: the link goes to the brand's privacy policy; with none set, the link is not shown (P2-T08).
	const { privacyUrl } = getBrand();
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
