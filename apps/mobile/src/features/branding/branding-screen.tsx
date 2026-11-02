import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Stack } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
	BRANDING_FONT_NAMES,
	brandPreviewVars,
	isHexColor,
	primaryContrast,
	readableForeground,
} from "@reactive-resume/utils/brand";
import {
	APP_NAME_MAX,
	buildPatch,
	formFromBranding,
	validateForm,
	type BrandingForm,
	type FormError,
} from "@reactive-resume/utils/brand-form";
import { useOrganizationAdmin } from "./access";
import { assetFileName, checkAsset, errorCode, type AssetKind } from "./logic";
import { client, orpc, rest } from "@/api/client";
import { useSession } from "@/auth/session";
import {
	Banner,
	Button,
	Card,
	ConfirmDialog,
	Screen,
	SelectSheet,
	Skeleton,
	Text,
	TextField,
	showToast,
	useTheme,
} from "@/ui";

/** Settings → Branding for owners and admins. The API checks the role on every call; the gate here is a convenience. */
export function BrandingScreen() {
	const { t } = useLingui();
	const access = useOrganizationAdmin();
	return (
		<Screen>
			<Stack.Screen options={{ title: t`Branding` }} />
			{access === "loading" ? (
				<Skeleton height={160} />
			) : access === "denied" ? (
				<Banner tone="warn" icon="lock" message={t`Only owners and admins can change the organization's branding.`} />
			) : (
				<BrandingEditor />
			)}
		</Screen>
	);
}

function BrandingEditor() {
	const { t } = useLingui();
	const { server } = useSession();
	const queryClient = useQueryClient();
	const query = useQuery({
		...orpc.branding.get.queryOptions(),
		queryKey: [...orpc.branding.get.key(), server],
		retry: false,
	});
	const key = [...orpc.branding.get.key(), server];
	const [form, setForm] = useState<BrandingForm | null>(null);

	const save = useMutation({
		mutationFn: (patch: ReturnType<typeof buildPatch>) => client.branding.update(patch as never),
		// Optimistic: the stored values show at once; a failure puts the previous ones back.
		onMutate: async (patch) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			if (previous) queryClient.setQueryData(key, { ...previous, ...patch });
			return { previous };
		},
		onError: (_error, _patch, context) => {
			if (context?.previous) queryClient.setQueryData(key, context.previous);
			showToast({ message: t`Couldn't save the branding. Check the highlighted fields and try again.` });
		},
		onSuccess: (data) => {
			queryClient.setQueryData(key, data);
			setForm(null);
			showToast({ message: t`Branding saved. Open tabs on your organization's address update within about a minute.` });
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.branding.get.key() }),
	});

	if (query.isPending) return <Skeleton height={160} />;
	if (query.isError)
		return (
			<Banner
				tone="danger"
				message={t`Couldn't load the branding.`}
				action={{ label: t`Try again`, onPress: () => void query.refetch() }}
			/>
		);

	const stored = query.data;
	const current = form ?? formFromBranding(stored);
	const errors = validateForm(current);
	const patch = buildPatch(current, stored);
	const dirty = Object.keys(patch).length > 0;
	const invalid = Object.keys(errors).length > 0;
	const set = <K extends keyof BrandingForm>(field: K, value: BrandingForm[K]) =>
		setForm({ ...current, [field]: value });
	const message = (error: FormError | undefined): string | undefined => {
		switch (error) {
			case "name-too-long":
				return t`Use ${APP_NAME_MAX} characters or fewer.`;
			case "color":
				return t`Use a colour like #1a56db.`;
			case "font":
				return t`Choose one of the listed fonts.`;
			case "sender":
				return t`Use a plain name without line breaks or angle brackets.`;
			case "sender-too-long":
				return t`Use 80 characters or fewer.`;
			case "email":
				return t`Use one address like help@example.com, without a name.`;
			case "url":
				return t`Use a full https:// address.`;
			default:
				return undefined;
		}
	};
	const primary = current.primaryColor.trim();
	const contrast = isHexColor(primary) ? primaryContrast(primary) : null;

	return (
		<>
			<Preview form={current} logoUrl={stored.logoUrl} />

			<Text variant="title">{t`Identity`}</Text>
			<TextField
				label={t`App name`}
				value={current.appName}
				error={message(errors.appName)}
				helper={t`Leave empty to use the platform default.`}
				onChangeText={(value) => set("appName", value)}
			/>
			<TextField
				label={t`Email sender name`}
				value={current.emailFromName}
				error={message(errors.emailFromName)}
				onChangeText={(value) => set("emailFromName", value)}
			/>
			<TextField
				label={t`Reply-to address`}
				value={current.emailReplyTo}
				error={message(errors.emailReplyTo)}
				keyboardType="email-address"
				autoCapitalize="none"
				autoCorrect={false}
				onChangeText={(value) => set("emailReplyTo", value)}
			/>

			<Text variant="title">{t`Colours and font`}</Text>
			<ColorInput
				label={t`Primary colour`}
				value={current.primaryColor}
				error={message(errors.primaryColor)}
				onChange={(value) => set("primaryColor", value)}
			/>
			{contrast && !contrast.passes ? (
				<Banner
					tone="warn"
					title={t`Text on this colour is hard to read`}
					message={t`The contrast is ${contrast.ratio.toFixed(1)}:1; accessible text needs at least 4.5:1.`}
				/>
			) : null}
			<ColorInput
				label={t`Secondary colour`}
				value={current.secondaryColor}
				error={message(errors.secondaryColor)}
				onChange={(value) => set("secondaryColor", value)}
			/>
			<SelectSheet
				label={t`Font`}
				value={current.font === "" ? "default" : current.font}
				options={[
					{ value: "default", label: t`Platform default` },
					...BRANDING_FONT_NAMES.map((font) => ({ value: font, label: font })),
				]}
				onChange={(value) => set("font", value === "default" ? "" : value)}
			/>

			<Text variant="title">{t`Legal links`}</Text>
			<TextField
				label={t`Support`}
				value={current.supportUrl}
				error={message(errors.supportUrl)}
				keyboardType="url"
				autoCapitalize="none"
				autoCorrect={false}
				onChangeText={(value) => set("supportUrl", value)}
			/>
			<TextField
				label={t`Terms of service`}
				value={current.termsUrl}
				error={message(errors.termsUrl)}
				keyboardType="url"
				autoCapitalize="none"
				autoCorrect={false}
				onChangeText={(value) => set("termsUrl", value)}
			/>
			<TextField
				label={t`Privacy policy`}
				value={current.privacyUrl}
				error={message(errors.privacyUrl)}
				keyboardType="url"
				autoCapitalize="none"
				autoCorrect={false}
				onChangeText={(value) => set("privacyUrl", value)}
			/>

			<Button
				label={t`Save changes`}
				size="lg"
				fullWidth
				loading={save.isPending}
				disabled={!dirty || invalid}
				onPress={() => save.mutate(patch)}
			/>
			{dirty ? <Button label={t`Discard`} variant="ghost" fullWidth onPress={() => setForm(null)} /> : null}

			<AssetCard kind="logo" url={stored.logoUrl} />
			<AssetCard kind="favicon" url={stored.faviconUrl} />
		</>
	);
}

type ColorInputProps = { label: string; value: string; error: string | undefined; onChange: (value: string) => void };

function ColorInput({ label, value, error, onChange }: ColorInputProps) {
	const { colors, radius, space } = useTheme();
	const swatch = isHexColor(value.trim()) ? value.trim() : null;
	return (
		<View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s3 }}>
			<View style={{ flex: 1 }}>
				<TextField
					label={label}
					value={value}
					error={error}
					placeholder="#1a56db"
					autoCapitalize="none"
					autoCorrect={false}
					mono
					onChangeText={onChange}
				/>
			</View>
			<View
				accessibilityElementsHidden
				importantForAccessibility="no-hide-descendants"
				style={{
					marginTop: space.s6,
					width: 44,
					height: 44,
					borderRadius: radius.rMd,
					borderWidth: 1,
					borderColor: colors.line,
					backgroundColor: swatch ?? colors.sunken,
				}}
			/>
		</View>
	);
}

type PreviewProps = { form: BrandingForm; logoUrl: string | null };

/** A sample header, button and card in the brand's colours. The secondary colour shows as a chip (Q96). */
function Preview({ form, logoUrl }: PreviewProps) {
	const { t } = useLingui();
	const { colors, radius, space } = useTheme();
	const vars = brandPreviewVars(form.primaryColor.trim(), form.secondaryColor.trim());
	const accent = vars["--accent"] ?? colors.accent;
	const onAccent = vars["--on-accent"] ?? colors.onAccent;
	const soft = vars["--accent-soft"] ?? colors.accentSoft;
	const softText = vars["--accent-text"] ?? colors.accentText;
	const secondary = vars["--brand-secondary"];
	const name = form.appName.trim() || t`Your app`;
	return (
		<Card accessibilityLabel={t`Preview of your branding`}>
			<View style={{ gap: space.s3 }}>
				<View style={{ flexDirection: "row", alignItems: "center", gap: space.s2 }}>
					{logoUrl && !/\.(?:svg|ico)$/.test(logoUrl) ? (
						<Image source={{ uri: logoUrl }} style={{ width: 24, height: 24 }} contentFit="contain" />
					) : (
						<View style={{ width: 24, height: 24, borderRadius: radius.rSm, backgroundColor: accent }} />
					)}
					<Text variant="heading">{name}</Text>
				</View>
				<View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s2, alignItems: "center" }}>
					<View
						style={{
							backgroundColor: accent,
							borderRadius: radius.rMd,
							paddingHorizontal: space.s3,
							paddingVertical: space.s2,
						}}
					>
						<Text style={{ color: onAccent }}>{t`Primary button`}</Text>
					</View>
					<View
						style={{
							backgroundColor: soft,
							borderRadius: radius.rSm,
							paddingHorizontal: space.s2,
							paddingVertical: space.s1,
						}}
					>
						<Text variant="caption" style={{ color: softText }}>{t`Highlight`}</Text>
					</View>
					{secondary ? (
						<View
							style={{
								backgroundColor: secondary,
								borderRadius: radius.rSm,
								paddingHorizontal: space.s2,
								paddingVertical: space.s1,
							}}
						>
							<Text variant="caption" style={{ color: readableForeground(secondary) }}>{t`Secondary`}</Text>
						</View>
					) : null}
				</View>
			</View>
		</Card>
	);
}

type AssetCardProps = { kind: AssetKind; url: string | null };

function AssetCard({ kind, url }: AssetCardProps) {
	const { t } = useLingui();
	const { space } = useTheme();
	const queryClient = useQueryClient();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const title = kind === "logo" ? t`Logo` : t`Favicon`;
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.branding.get.key() });

	const upload = useMutation({
		mutationFn: async () => {
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				allowsEditing: false,
				quality: 1,
			});
			if (result.canceled) return false;
			const asset = result.assets[0];
			if (!asset) throw new Error("no-asset");
			const file = new File(asset.uri);
			const check = checkAsset(kind, asset.mimeType, file.size);
			if (check === "type") throw new Error("type");
			if (check === "size") throw new Error("size");
			const form = new FormData();
			form.append("file", file, assetFileName(kind, asset.mimeType ?? "image/png"));
			const response = await rest(`/branding/${kind}`, { method: "POST", body: form });
			if (!response.ok) throw new Error("upload");
			return true;
		},
		onSuccess: (done) => {
			if (done) showToast({ message: kind === "logo" ? t`Logo uploaded.` : t`Favicon uploaded.` });
			void refresh();
		},
		onError: (error) =>
			showToast({
				message:
					error.message === "type"
						? kind === "logo"
							? t`Choose a PNG or WebP image.`
							: t`Choose a PNG image.`
						: error.message === "size"
							? kind === "logo"
								? t`Choose an image of 512 KB or less.`
								: t`Choose an image of 128 KB or less.`
							: t`Couldn't upload the image. Try again.`,
			}),
	});

	const remove = useMutation({
		mutationFn: () => (kind === "logo" ? client.branding.deleteLogo() : client.branding.deleteFavicon()),
		onSuccess: () => void refresh(),
		onError: (error) =>
			showToast({
				message: errorCode(error) === "NOT_FOUND" ? t`There is nothing to remove.` : t`Couldn't remove it. Try again.`,
			}),
		onSettled: () => setConfirmRemove(false),
	});

	return (
		<Card>
			<View style={{ gap: space.s3 }}>
				<Text variant="heading">{title}</Text>
				<Text variant="callout" color="ink3">
					{kind === "logo"
						? t`PNG or WebP, up to 512 KB. Upload a PNG or WebP so the logo also shows in the mobile app and in emails; they don't show an SVG. To use an SVG, upload it from the web app.`
						: t`PNG, up to 128 KB. To use an ICO, upload it from the web app.`}
				</Text>
				{url && !/\.(?:svg|ico)$/.test(url) ? (
					<Image source={{ uri: url }} style={{ width: 48, height: 48 }} contentFit="contain" />
				) : null}
				<View style={{ flexDirection: "row", gap: space.s2 }}>
					<Button
						label={url ? t`Replace` : t`Upload`}
						variant="secondary"
						loading={upload.isPending}
						onPress={() => upload.mutate()}
					/>
					{url ? <Button label={t`Remove`} variant="ghost" onPress={() => setConfirmRemove(true)} /> : null}
				</View>
			</View>
			<ConfirmDialog
				open={confirmRemove}
				title={kind === "logo" ? t`Remove the logo?` : t`Remove the favicon?`}
				message={t`The platform default shows again.`}
				confirmLabel={t`Remove`}
				destructive
				onConfirm={() => remove.mutate()}
				onCancel={() => setConfirmRemove(false)}
			/>
		</Card>
	);
}
