import type { TemplateEntry } from "./queries";
import type { Application } from "@/features/applications/types";
import {
	buildMailto,
	copyText,
	MAX_BODY_LENGTH,
	MAX_SUBJECT_LENGTH,
	templatesForStage,
} from "@careeros/email-templates";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@reactive-resume/ui/components/sheet";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";
import { cn } from "@reactive-resume/utils/style";
import { getKindLabel, getSourceLabel } from "./labels";
import { useEmailTemplates, useRefreshEmailTemplates } from "./queries";
import { TemplateEditor } from "./template-editor";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P5-T04): "Write email" in an application's workspace. Pick the template for the application's stage, read it
// filled in from the application, edit it, and send it from your own mail app or copy it. The platform never sends
// the email. The sheet's open state is URL state (`?email`), like the coach sheet beside it.

type WriteEmailSheetProps = {
	application: Application;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function WriteEmailSheet({ application, open, onOpenChange }: WriteEmailSheetProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				closeLabel={t`Close`}
				className="gap-0 border-s border-line data-[side=right]:sm:max-w-none data-[side=right]:md:max-w-[480px]"
			>
				<WriteEmailBody application={application} />
			</SheetContent>
		</Sheet>
	);
}

type BodyProps = { application: Application };

function WriteEmailBody({ application }: BodyProps) {
	const { i18n } = useLingui();
	const ids = { template: useId(), subject: useId(), message: useId(), all: useId() };
	const templates = useEmailTemplates();
	const refresh = useRefreshEmailTemplates();
	const [showAll, setShowAll] = useState(false);
	const [picked, setPicked] = useState<string | null>(null);
	// What the person typed over the filled-in text, for the template it was typed on. Another template starts afresh.
	const [edits, setEdits] = useState<{ id: string; subject?: string; body?: string } | null>(null);
	const [saving, setSaving] = useState(false);

	const entries = templates.entries ?? [];
	const suggested = templatesForStage(entries, application.status);
	// A stage with nothing suggested (Closed) shows every template.
	const options = showAll || suggested.length === 0 ? entries : suggested;
	const selected: TemplateEntry | undefined = options.find((entry) => entry.id === picked) ?? options[0];

	// A built-in is sent with the text the screen shows, so the preview is filled in in the person's language.
	const render = useQuery({
		...orpc.emailTemplates.render.queryOptions({
			input: {
				templateId: selected?.id ?? "",
				applicationId: application.id,
				locale: i18n.locale,
				...(selected?.source === "builtin" ? { source: { subject: selected.subject, body: selected.body } } : {}),
			},
		}),
		enabled: selected !== undefined,
		retry: false,
		staleTime: 0,
		gcTime: 0,
	});

	const edited = selected && edits?.id === selected.id ? edits : null;
	const subject = edited?.subject ?? render.data?.subject ?? "";
	const body = edited?.body ?? render.data?.body ?? "";
	const ready = selected !== undefined && render.data !== undefined;
	const mail = buildMailto({ to: render.data?.to, subject, body });
	const unfilled = (render.data?.missing ?? []).some(
		(name) => subject.includes(`[${name}]`) || body.includes(`[${name}]`),
	);

	const edit = (patch: { subject?: string; body?: string }) => {
		if (selected) setEdits({ ...edited, ...patch, id: selected.id });
	};

	const copy = async (message: string) => {
		try {
			await navigator.clipboard.writeText(copyText({ subject, body }));
			toast.add({ description: message });
		} catch {
			toast.add({ type: "error", description: t`Couldn't copy. Select the text and copy it yourself.` });
		}
	};

	const create = useMutation(
		orpc.emailTemplates.create.mutationOptions({
			onSuccess: async () => {
				setSaving(false);
				toast.add({ description: t`Saved to your templates` });
				await refresh();
			},
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't save the template. Try again.`),
				}),
		}),
	);

	return (
		<div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
			<header className="grid gap-0.5 border-b border-line px-4 py-3.5 pe-12">
				<SheetTitle className="font-sans text-[15px] leading-5 font-semibold">
					<Trans>Write email</Trans>
				</SheetTitle>
				<SheetDescription className="truncate text-xs text-ink-3">
					{application.role} · {application.company}
				</SheetDescription>
			</header>

			<div className="grid content-start gap-4 overflow-y-auto overscroll-contain p-4">
				{templates.isPending ? (
					<Skeleton className="h-40 rounded-lg" />
				) : templates.isError ? (
					<div role="alert" className="grid justify-items-start gap-2 text-sm text-ink-2">
						<p>
							<Trans>The templates couldn't be loaded.</Trans>
						</p>
						<Button size="sm" variant="secondary" onClick={() => void templates.refetch()}>
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : (
					<>
						<div className="grid gap-1.5">
							<Label htmlFor={ids.template}>
								<Trans>Template</Trans>
							</Label>
							<NativeSelect
								id={ids.template}
								value={selected?.id ?? ""}
								onChange={(event) => setPicked(event.target.value)}
							>
								{options.map((entry) => (
									<option key={entry.id} value={entry.id}>
										{entry.name} · {getKindLabel(entry.kind)} · {getSourceLabel(entry.source)}
									</option>
								))}
							</NativeSelect>
							{suggested.length > 0 && suggested.length < entries.length && (
								<div className="flex items-center gap-2 text-[13px] text-ink-2">
									<Checkbox
										id={ids.all}
										checked={showAll}
										onCheckedChange={(checked) => setShowAll(checked === true)}
									/>
									<Label htmlFor={ids.all}>
										<Trans>Show templates for every stage</Trans>
									</Label>
								</div>
							)}
						</div>

						{render.isError ? (
							<div role="alert" className="grid justify-items-start gap-2 text-sm text-ink-2">
								<p>
									<Trans>This template couldn't be filled in. Try again.</Trans>
								</p>
								<Button size="sm" variant="secondary" onClick={() => void render.refetch()}>
									<Trans>Try again</Trans>
								</Button>
							</div>
						) : !ready ? (
							<Skeleton className="h-52 rounded-lg" />
						) : (
							<>
								<p className="text-[13px] text-ink-2" data-testid="write-email-to">
									{render.data.to ? (
										<Trans>To: {render.data.to}</Trans>
									) : (
										<Trans>No email address for this contact yet. Add it in your mail app.</Trans>
									)}
								</p>
								<div className="grid gap-1.5">
									<Label htmlFor={ids.subject}>
										<Trans>Subject</Trans>
									</Label>
									<Input
										id={ids.subject}
										value={subject}
										maxLength={MAX_SUBJECT_LENGTH}
										onChange={(event) => edit({ subject: event.target.value })}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor={ids.message}>
										<Trans>Message</Trans>
									</Label>
									<Textarea
										id={ids.message}
										value={body}
										maxLength={MAX_BODY_LENGTH}
										onChange={(event) => edit({ body: event.target.value })}
										className="min-h-[260px] px-3.5 py-3 text-sm leading-[22px] pointer-coarse:text-base"
									/>
								</div>
								{unfilled && (
									<p className="flex gap-2 text-[13px] text-warn-text">
										<Icon name="warning-circle" size={17} className="mt-0.5 shrink-0" />
										<Trans>Fill in the [bracketed] parts before you send it.</Trans>
									</p>
								)}
								<div className="flex flex-wrap items-center gap-2">
									{mail.mode === "mailto" ? (
										<a href={mail.url} className={cn(buttonVariants())} data-testid="write-email-open-mail">
											<Icon name="envelope-simple" size={18} />
											<Trans>Open in mail app</Trans>
										</a>
									) : (
										<Button
											onClick={() =>
												void copy(t`This email is too long to open in your mail app, so it was copied instead.`)
											}
										>
											<Icon name="envelope-simple" size={18} />
											<Trans>Open in mail app</Trans>
										</Button>
									)}
									<Button variant="secondary" onClick={() => void copy(t`Email copied`)}>
										<Icon name="copy" size={16} />
										<Trans>Copy</Trans>
									</Button>
									<Button variant="ghost" onClick={() => setSaving(true)}>
										<Trans>Save as my template</Trans>
									</Button>
								</div>
								<p className="text-xs text-ink-3">
									<Trans>You send it from your own email. Nothing is sent from here.</Trans>
								</p>
							</>
						)}
					</>
				)}
			</div>

			{selected && (
				<TemplateEditor
					open={saving}
					onOpenChange={setSaving}
					title={<Trans>Save as my template</Trans>}
					description={
						<Trans>
							It is saved as it reads now. To reuse it for other applications, put {"{{company}}"} and the other
							variables back where the details are.
						</Trans>
					}
					initial={{
						kind: selected.kind,
						stageCategory: selected.stageCategories[0] ?? null,
						name: selected.source === "mine" ? selected.name : t`${selected.name} (mine)`,
						subject,
						body,
					}}
					saveLabel={<Trans>Save template</Trans>}
					saving={create.isPending}
					onSave={(draft) => create.mutate(draft)}
				/>
			)}
		</div>
	);
}
