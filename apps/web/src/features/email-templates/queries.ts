import type { RouterOutput } from "@/libs/orpc/client";
import { useLingui } from "@lingui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { translateTemplate } from "./built-in-text";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P5-T04): data hooks for email templates. Every call is made for the session's own organization and member;
// no hook passes either. The server decides what the member may see.

export type TemplateEntry = RouterOutput["emailTemplates"]["list"][number];

/** The member's templates, the organization's defaults and the built-ins, the built-ins in the language of the screen. */
export function useEmailTemplates() {
	const { i18n } = useLingui();
	const query = useQuery(orpc.emailTemplates.list.queryOptions());
	return { ...query, entries: query.data?.map((entry) => translateTemplate(i18n, entry)) };
}

export function useRefreshEmailTemplates() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: orpc.emailTemplates.key() });
}
