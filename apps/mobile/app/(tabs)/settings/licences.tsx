import { useLingui } from "@lingui/react/macro";
import { Stack } from "expo-router";
import { useState } from "react";
import { FlatList, ScrollView, View } from "react-native";
// CAREEROS: the "Product" tab shows the MIT notice from NOTICE, the same text as the web /licenses page (P2-T08).
import { NOTICE_ENTRIES, NOTICE_INTRO } from "@reactive-resume/utils/notice";
import { javascriptNotices, licenceTexts, nativeNotices } from "@/features/licences/notices";
import { ListRow, Screen, Segmented, Text, useTheme } from "@/ui";

export default function LicencesScreen() {
	const { t } = useLingui();
	const { space } = useTheme();
	const [kind, setKind] = useState<"product" | "native" | "javascript">("product");
	const [expanded, setExpanded] = useState<string | null>(null);
	return (
		<Screen scroll={false}>
			<Stack.Screen options={{ title: t`Licenses` }} />
			<Text color="ink2">{t`Third-party software notices. Tap a dependency to read its license.`}</Text>
			<Segmented
				label={t`Dependency type`}
				value={kind}
				onChange={(value) => {
					setKind(value);
					setExpanded(null);
				}}
				options={[
					{ value: "product", label: t`Product` },
					{ value: "native", label: t`Native & fonts` },
					{ value: "javascript", label: t`JavaScript` },
				]}
			/>
			{kind === "product" ? (
				<ScrollView contentContainerStyle={{ gap: space.s4, padding: space.s4 }}>
					<Text selectable variant="callout">
						{NOTICE_INTRO}
					</Text>
					{NOTICE_ENTRIES.map((entry) => (
						<View key={entry.name} style={{ gap: space.s2 }}>
							<Text variant="heading">{entry.name}</Text>
							<Text selectable variant="caption" color="ink3">
								{entry.url}
							</Text>
							<Text selectable variant="callout">
								{entry.license}
							</Text>
						</View>
					))}
				</ScrollView>
			) : (
				<FlatList
					data={kind === "native" ? nativeNotices : javascriptNotices}
					keyExtractor={(item) => item.title}
					extraData={expanded}
					initialNumToRender={12}
					renderItem={({ item }) => (
						<View>
							<ListRow
								title={item.title}
								selected={expanded === item.title}
								accessibilityHint={expanded === item.title ? t`Hide license` : t`Read license`}
								onPress={() => setExpanded(expanded === item.title ? null : item.title)}
							/>
							{expanded === item.title && (
								<View style={{ padding: space.s4, gap: space.s3 }}>
									{item.textIds.map((id, paragraph) => (
										<Text key={`${id}:${paragraph}`} selectable variant="callout">
											{licenceTexts[id]}
										</Text>
									))}
								</View>
							)}
						</View>
					)}
				/>
			)}
		</Screen>
	);
}
