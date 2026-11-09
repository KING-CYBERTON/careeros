import type { RouterOutput } from "@/api/client";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { translateTemplate } from "./built-in-text";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";

// CAREEROS (P5-T04): data hooks for email templates, the twin of apps/web/src/features/email-templates/queries.ts.
// Every call is made for the session's own organization and member; the server decides what the member may see.

export type TemplateEntry = RouterOutput["emailTemplates"]["list"][number];

/** The member's templates, the organization's defaults and the built-ins, the built-ins in the language of the screen. */
export function useEmailTemplates() {
	const { i18n } = useLingui();
	const { server, status } = useSession();
	const query = useQuery({
		...orpc.emailTemplates.list.queryOptions(),
		queryKey: [...orpc.emailTemplates.list.key(), server],
		enabled: status === "signed-in",
	});
	return { ...query, entries: query.data?.map((entry) => translateTemplate(i18n, entry)) };
}

export function useRefreshEmailTemplates() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: orpc.emailTemplates.key() });
}
