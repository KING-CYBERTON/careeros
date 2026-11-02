import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { BRANDING_FONT_NAMES, isHexColor, primaryContrast } from "@reactive-resume/utils/brand";
import { RequireBrandingAdmin } from "./access";
import {
	APP_NAME_MAX,
	buildPatch,
	colorInputValue,
	formFromBranding,
	validateForm,
	type BrandingData,
	type BrandingForm,
	type FormError,
} from "./form";
import { BrandPreview } from "./preview";
import { useBranding, useBrandingMutations } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { getBrand } from "@/libs/brand";
import { getReadableErrorMessage } from "@/libs/error-message";

const errorText = (error: FormError | undefined): string | undefined => {
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

export function BrandingSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Branding</Trans>}
				description={<Trans>How your organization looks to its members.</Trans>}
			/>
			<RequireBrandingAdmin>
				<BrandingBody />
			</RequireBrandingAdmin>
		</>
	);
}

function BrandingBody() {
	const { data, isLoading, error } = useBranding();
	if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
	if (error || !data)
		return (
			<Alert variant="error">
				<Icon name="warning" />
				<AlertTitle>
					<Trans>Couldn't load the branding</Trans>
				</AlertTitle>
				<AlertDescription>{getReadableErrorMessage(error, t`Try again in a moment.`)}</AlertDescription>
			</Alert>
		);
	return <BrandingEditor stored={data} />;
}

type FieldProps = {
	label: string;
	help?: string | undefined;
	error?: string | undefined;
	children: (props: { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined }) => React.ReactNode;
};

function Field({ label, help, error, children }: FieldProps) {
	const id = useId();
	const noteId = `${id}-note`;
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children({ id, "aria-invalid": Boolean(error), "aria-describedby": error || help ? noteId : undefined })}
			{(error || help) && (
				<p id={noteId} className={error ? "text-[13px] text-danger-text" : "text-[13px] text-ink-3"}>
					{error ?? help}
				</p>
			)}
		</div>
	);
}

type ColorFieldProps = {
	label: string;
	value: string;
	error?: string | undefined;
	onChange: (value: string) => void;
	fallback: string;
};

function ColorField({ label, value, error, onChange, fallback }: ColorFieldProps) {
	return (
		<Field label={label} error={error}>
			{(props) => (
				<div className="flex items-center gap-2">
					<input
						type="color"
						aria-label={t`${label} colour picker`}
						className="size-9 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0.5"
						value={colorInputValue(value, fallback)}
						onChange={(event) => onChange(event.target.value)}
					/>
					<Input
						{...props}
						value={value}
						placeholder="#1a56db"
						spellCheck={false}
						onChange={(event) => onChange(event.target.value)}
					/>
				</div>
			)}
		</Field>
	);
}

type BrandingEditorProps = { stored: BrandingData & { logoUrl: string | null; faviconUrl: string | null } };

function BrandingEditor({ stored }: BrandingEditorProps) {
	const { update, ...assets } = useBrandingMutations();
	const [form, setForm] = useState<BrandingForm>(() => formFromBranding(stored));
	// A save, or a change made elsewhere, replaces the form with what is stored, but never while there are unsaved edits.
	const baseline = useRef(JSON.stringify(formFromBranding(stored)));
	useEffect(() => {
		const next = JSON.stringify(formFromBranding(stored));
		setForm((current) => (JSON.stringify(current) === baseline.current ? formFromBranding(stored) : current));
		baseline.current = next;
	}, [stored]);

	const set = <K extends keyof BrandingForm>(field: K, value: BrandingForm[K]) =>
		setForm((current) => ({ ...current, [field]: value }));
	const errors = validateForm(form);
	const patch = buildPatch(form, stored);
	const dirty = Object.keys(patch).length > 0;
	const invalid = Object.keys(errors).length > 0;

	const primary = form.primaryColor.trim();
	const contrast = isHexColor(primary) ? primaryContrast(primary) : null;
	const previewName = form.appName.trim() || getBrandName();

	const save = () => {
		if (invalid || !dirty) return;
		update.mutate(patch, {
			onSuccess: () =>
				toast.add({
					description: t`Branding saved. Open tabs on your organization's address update within about a minute.`,
				}),
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't save the branding. Try again.`),
				}),
		});
	};

	return (
		<form
			className="grid gap-8"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<BrandPreview
				appName={previewName}
				logoUrl={stored.logoUrl}
				primaryColor={form.primaryColor}
				secondaryColor={form.secondaryColor}
				font={form.font}
			/>

			<SettingsSection
				title={<Trans>Identity</Trans>}
				description={<Trans>Leave a field empty to use the platform default.</Trans>}
			>
				<Field
					label={t`App name`}
					error={errorText(errors.appName)}
					help={t`Shown in the title, the header and emails. Up to ${APP_NAME_MAX} characters.`}
				>
					{(props) => (
						<Input
							{...props}
							value={form.appName}
							maxLength={APP_NAME_MAX + 20}
							onChange={(event) => set("appName", event.target.value)}
						/>
					)}
				</Field>
				<Field
					label={t`Email sender name`}
					error={errorText(errors.emailFromName)}
					help={t`The name people see on emails from your organization.`}
				>
					{(props) => (
						<Input
							{...props}
							value={form.emailFromName}
							onChange={(event) => set("emailFromName", event.target.value)}
						/>
					)}
				</Field>
				<Field
					label={t`Reply-to address`}
					error={errorText(errors.emailReplyTo)}
					help={t`Replies to your organization's emails go here.`}
				>
					{(props) => (
						<Input
							{...props}
							type="email"
							value={form.emailReplyTo}
							onChange={(event) => set("emailReplyTo", event.target.value)}
						/>
					)}
				</Field>
			</SettingsSection>

			<SettingsSection title={<Trans>Colours and font</Trans>}>
				<ColorField
					label={t`Primary colour`}
					value={form.primaryColor}
					fallback="#1a56db"
					error={errorText(errors.primaryColor)}
					onChange={(value) => set("primaryColor", value)}
				/>
				{contrast && !contrast.passes && (
					<Alert variant="warn" data-testid="contrast-warning">
						<Icon name="warning" />
						<AlertTitle>
							<Trans>Text on this colour is hard to read</Trans>
						</AlertTitle>
						<AlertDescription>
							<Trans>
								The contrast is {contrast.ratio.toFixed(1)}:1; accessible text needs at least 4.5:1. Choose a lighter or
								darker primary colour.
							</Trans>
						</AlertDescription>
					</Alert>
				)}
				<ColorField
					label={t`Secondary colour`}
					value={form.secondaryColor}
					fallback="#64748b"
					error={errorText(errors.secondaryColor)}
					onChange={(value) => set("secondaryColor", value)}
				/>
				<Field label={t`Font`} error={errorText(errors.font)}>
					{(props) => (
						<NativeSelect {...props} value={form.font} onChange={(event) => set("font", event.target.value)}>
							<option value="">{t`Platform default`}</option>
							{BRANDING_FONT_NAMES.map((font) => (
								<option key={font} value={font}>
									{font}
								</option>
							))}
						</NativeSelect>
					)}
				</Field>
			</SettingsSection>

			<SettingsSection
				title={<Trans>Legal links</Trans>}
				description={<Trans>Shown on the sign-in page and in settings. https:// only.</Trans>}
			>
				<Field label={t`Support`} error={errorText(errors.supportUrl)}>
					{(props) => (
						<Input
							{...props}
							type="url"
							value={form.supportUrl}
							placeholder="https://example.com/help"
							onChange={(event) => set("supportUrl", event.target.value)}
						/>
					)}
				</Field>
				<Field label={t`Terms of service`} error={errorText(errors.termsUrl)}>
					{(props) => (
						<Input
							{...props}
							type="url"
							value={form.termsUrl}
							placeholder="https://example.com/terms"
							onChange={(event) => set("termsUrl", event.target.value)}
						/>
					)}
				</Field>
				<Field label={t`Privacy policy`} error={errorText(errors.privacyUrl)}>
					{(props) => (
						<Input
							{...props}
							type="url"
							value={form.privacyUrl}
							placeholder="https://example.com/privacy"
							onChange={(event) => set("privacyUrl", event.target.value)}
						/>
					)}
				</Field>
			</SettingsSection>

			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" loading={update.isPending} disabled={!dirty || invalid}>
					<Trans>Save changes</Trans>
				</Button>
				<Button type="button" variant="ghost" disabled={!dirty} onClick={() => setForm(formFromBranding(stored))}>
					<Trans>Discard</Trans>
				</Button>
				<p className="text-[13px] text-ink-3">
					<Trans>Pages already open on your organization's address pick up changes within about a minute.</Trans>
				</p>
			</div>

			<AssetSection
				kind="logo"
				title={t`Logo`}
				url={stored.logoUrl}
				help={t`PNG, SVG or WebP, up to 512 KB. Use PNG or WebP if you want the logo in the mobile app and in emails too: they don't show an SVG.`}
				accept="image/png,image/svg+xml,image/webp"
				upload={assets.uploadLogo}
				remove={assets.deleteLogo}
			/>
			<AssetSection
				kind="favicon"
				title={t`Favicon`}
				url={stored.faviconUrl}
				help={t`PNG or ICO, up to 128 KB.`}
				accept="image/png,image/x-icon,.ico"
				upload={assets.uploadFavicon}
				remove={assets.deleteFavicon}
			/>
		</form>
	);
}

const getBrandName = () => getBrand().appName;

type MutationLike<TInput> = {
	mutate: (input: TInput, options?: { onError?: (error: unknown) => void; onSuccess?: () => void }) => void;
	isPending: boolean;
};

type AssetSectionProps = {
	kind: "logo" | "favicon";
	title: string;
	url: string | null;
	help: string;
	accept: string;
	upload: MutationLike<{ file: File }>;
	remove: MutationLike<undefined>;
};

function AssetSection({ kind, title, url, help, accept, upload, remove }: AssetSectionProps) {
	const input = useRef<HTMLInputElement>(null);
	const confirm = useConfirm();

	const choose = (file: File | undefined) => {
		if (!file) return;
		upload.mutate(
			{ file },
			{
				onSuccess: () => toast.add({ description: kind === "logo" ? t`Logo uploaded.` : t`Favicon uploaded.` }),
				onError: (error) =>
					toast.add({
						type: "error",
						description: getReadableErrorMessage(
							error,
							kind === "logo" ? t`Couldn't upload the logo.` : t`Couldn't upload the favicon.`,
						),
					}),
			},
		);
		if (input.current) input.current.value = "";
	};

	const removeAsset = async () => {
		const confirmed = await confirm(kind === "logo" ? t`Remove the logo?` : t`Remove the favicon?`, {
			description: t`The platform default shows again.`,
			confirmText: t`Remove`,
		});
		if (!confirmed) return;
		remove.mutate(undefined, {
			onError: (error) =>
				toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't remove it. Try again.`) }),
		});
	};

	return (
		<SettingsSection title={title} description={help}>
			<div className="flex flex-wrap items-center gap-3">
				{url ? (
					<img src={url} alt="" className="size-12 rounded-md border border-line bg-paper object-contain p-1" />
				) : (
					<span className="grid size-12 place-items-center rounded-md border border-dashed border-line text-ink-3">
						<Icon name="palette" size={20} />
					</span>
				)}
				<input
					ref={input}
					type="file"
					accept={accept}
					className="sr-only"
					tabIndex={-1}
					aria-hidden
					data-testid={`${kind}-input`}
					onChange={(event) => choose(event.target.files?.[0])}
				/>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					loading={upload.isPending}
					onClick={() => input.current?.click()}
				>
					{url ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}
				</Button>
				{url && (
					<Button type="button" size="sm" variant="ghost" loading={remove.isPending} onClick={() => void removeAsset()}>
						<Trans>Remove</Trans>
					</Button>
				)}
			</div>
		</SettingsSection>
	);
}
