// CAREEROS (P5-T03): the clip view. It reads the tab the member is looking at (one injected function, `activeTab`), fills a
// form from what the page says, and saves it to the member's tracker with the clipper token. Everything the page said is
// shown as text in form fields and text nodes; nothing is ever rendered as HTML. A failed save or tidy keeps the form.
import type { ClipError, Duplicate } from "../lib/clip-api";
import type { Clip, ClipFields, ClipOrigin } from "../lib/posting";
import type { Session } from "../lib/session";
import { useEffect, useId, useState } from "react";
import { Alert } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { isDevHttpHost } from "../lib/address";
import { findDuplicate, saveClip, tidyAvailable, tidyClip } from "../lib/clip-api";
import { DEV_HTTP_HOSTS } from "../lib/config";
import { EMPTY_FIELDS, parsePosting } from "../lib/posting";
import { readPageInTab, readRawPage } from "../lib/reader";
import { strings } from "./strings";

type ClipViewProps = {
	session: Session;
	origin: string;
	onSignedOut: () => void;
};

const parseOptions = { allowHttp: (host: string) => isDevHttpHost(host, DEV_HTTP_HOSTS) };

/** The address of the member's own page for an application. The id is checked before it is used. */
export function applicationLink(origin: string, id: string): string {
	return `${origin}/dashboard/applications?applicationId=${encodeURIComponent(id)}`;
}

/** Reads the active tab. A page that cannot be read (a browser page, a PDF, a refused injection) gives `null`. */
async function readActiveTab(): Promise<Clip | null> {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab || tab.id === undefined || typeof tab.url !== "string" || !/^https?:\/\//i.test(tab.url)) return null;
		const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageInTab });
		const raw = readRawPage(injected?.result);
		return raw ? parsePosting(raw, parseOptions) : null;
	} catch {
		return null;
	}
}

const errorText: Record<ClipError, string> = {
	signed_out: strings.errorSignedOut,
	suspended: strings.errorSuspended,
	quota: strings.errorQuota,
	offline: strings.errorOffline,
	failed: strings.errorFailed,
};

const originText: Record<ClipOrigin, string> = {
	page: strings.originPage,
	guess: strings.originGuess,
	none: strings.originNone,
};

export function ClipView(props: ClipViewProps) {
	const { session, origin } = props;
	const ids = {
		title: useId(),
		company: useId(),
		location: useId(),
		salary: useId(),
		url: useId(),
		description: useId(),
	};
	const [phase, setPhase] = useState<"reading" | "form" | "saved">("reading");
	const [unreadable, setUnreadable] = useState(false);
	const [clipOrigin, setClipOrigin] = useState<ClipOrigin>("none");
	const [fields, setFields] = useState<ClipFields>(EMPTY_FIELDS);
	const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
	const [canTidy, setCanTidy] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState<"save" | "tidy" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [savedId, setSavedId] = useState<string | null>(null);
	const [touched, setTouched] = useState(false);

	// On open: read the page, then check for a duplicate and whether the AI tidy is offered. Neither blocks the form.
	useEffect(() => {
		let active = true;
		void (async () => {
			const clip = await readActiveTab();
			if (!active) return;
			if (clip) {
				setFields(clip.fields);
				setClipOrigin(clip.origin);
			} else {
				setUnreadable(true);
			}
			setPhase("form");
			const [found, tidy] = await Promise.all([
				clip ? findDuplicate(session, origin, clip.fields.url) : Promise.resolve(null),
				tidyAvailable(session, origin),
			]);
			if (!active) return;
			setDuplicate(found);
			setCanTidy(tidy);
		})();
		return () => {
			active = false;
		};
	}, [session, origin]);

	function edit(key: keyof ClipFields, value: string) {
		setFields((current) => ({ ...current, [key]: value }));
		setInfo(null);
	}

	async function recheckDuplicate() {
		setDuplicate(await findDuplicate(session, origin, fields.url.trim()));
	}

	function fail(kind: ClipError, fallback: string) {
		if (kind === "signed_out") return props.onSignedOut();
		setError(kind === "failed" ? fallback : errorText[kind]);
	}

	async function save() {
		setTouched(true);
		setError(null);
		if (!fields.title.trim() || !fields.company.trim()) return;
		setBusy("save");
		const result = await saveClip(session, origin, fields);
		setBusy(null);
		if (!result.ok) return fail(result.error, strings.errorFailed);
		setSavedId(result.id);
		setPhase("saved");
	}

	async function tidy() {
		setTouched(true);
		setError(null);
		setInfo(null);
		if (!fields.title.trim() || !fields.company.trim()) return;
		setBusy("tidy");
		const result = await tidyClip(session, origin, fields);
		setBusy(null);
		if (!result.ok) return fail(result.error, strings.errorTidyFailed);
		if (!result.tidied) return setInfo(strings.tidyUnchanged);
		setFields((current) => ({ ...current, ...result.fields }));
		setInfo(strings.tidyDone);
	}

	if (phase === "reading")
		return (
			<p className="text-[13px] text-ink-2" role="status">
				{strings.clipReading}
			</p>
		);

	if (phase === "saved" && savedId)
		return (
			<section className="flex flex-col gap-3" aria-label={strings.saved}>
				<p className="text-sm font-semibold text-ink" role="status" data-testid="clip-saved">
					{strings.saved}
				</p>
				<p className="truncate text-[13px] text-ink-2">
					{fields.title} · {fields.company}
				</p>
				<Button onClick={() => void chrome.tabs.create({ url: applicationLink(origin, savedId) })}>
					{strings.openSaved}
				</Button>
			</section>
		);

	const missing = touched && (!fields.title.trim() || !fields.company.trim());
	const longDescription = fields.description.length > 400;

	return (
		<section className="flex flex-col gap-3" aria-label={strings.clipTitle}>
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold text-ink">{strings.clipTitle}</h2>
				<span className="rounded-full border border-line-2 px-2 py-0.5 text-xs text-ink-2" data-testid="clip-origin">
					{originText[clipOrigin]}
				</span>
			</div>

			{unreadable ? <Alert>{strings.clipUnreadable}</Alert> : null}
			{error ? <Alert variant="error">{error}</Alert> : null}
			{info ? <Alert>{info}</Alert> : null}
			{missing ? <Alert variant="error">{strings.needTitleAndCompany}</Alert> : null}

			{duplicate ? (
				<Alert data-testid="clip-duplicate">
					<span>{strings.duplicate}</span>{" "}
					<Button
						variant="link"
						size="sm"
						onClick={() => void chrome.tabs.create({ url: applicationLink(origin, duplicate.id) })}
					>
						{strings.openApplication}
					</Button>
				</Alert>
			) : null}

			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.title}>{strings.fieldTitle}</Label>
				<Input
					id={ids.title}
					value={fields.title}
					maxLength={300}
					required
					aria-required="true"
					onChange={(event) => edit("title", event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.company}>{strings.fieldCompany}</Label>
				<Input
					id={ids.company}
					value={fields.company}
					maxLength={300}
					required
					aria-required="true"
					onChange={(event) => edit("company", event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.location}>{strings.fieldLocation}</Label>
				<Input
					id={ids.location}
					value={fields.location}
					maxLength={300}
					onChange={(event) => edit("location", event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.salary}>{strings.fieldSalary}</Label>
				<Input
					id={ids.salary}
					value={fields.salary}
					maxLength={300}
					onChange={(event) => edit("salary", event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.url}>{strings.fieldUrl}</Label>
				<Input
					id={ids.url}
					value={fields.url}
					maxLength={2048}
					inputMode="url"
					onChange={(event) => edit("url", event.target.value)}
					onBlur={() => void recheckDuplicate()}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={ids.description}>{strings.fieldDescription}</Label>
				<Textarea
					id={ids.description}
					value={fields.description}
					maxLength={20_000}
					rows={expanded ? 14 : 4}
					className={expanded ? "" : "max-h-24 overflow-hidden"}
					onChange={(event) => edit("description", event.target.value)}
				/>
				{longDescription || expanded ? (
					<Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded((value) => !value)}>
						{expanded ? strings.hideDescription : strings.showDescription}
					</Button>
				) : null}
			</div>

			<div className="flex flex-wrap gap-2">
				<Button disabled={busy !== null} onClick={() => void save()}>
					{busy === "save" ? strings.saving : duplicate ? strings.saveAnyway : strings.save}
				</Button>
				{canTidy ? (
					<Button variant="secondary" disabled={busy !== null} onClick={() => void tidy()}>
						{busy === "tidy" ? strings.tidying : strings.tidy}
					</Button>
				) : null}
			</div>
		</section>
	);
}
