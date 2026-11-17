import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingsGroup } from "./layout";
import { client, orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { Banner, ConfirmDialog, EmptyState, ListRow, Text, showToast } from "@/ui";

// CAREEROS (P5-T02): the member's Job Clipper sign-ins, the same list as Settings on the web, each revocable.
// Approving a sign-in happens in a desktop browser, so the phone only lists and revokes.

type ClipperSignInsProps = { userId: string };
export function ClipperSignIns({ userId }: ClipperSignInsProps) {
	const { t, i18n } = useLingui();
	const { server } = useSession();
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
	const tokens = useQuery(
		orpc.clipper.listTokens.queryOptions({
			queryKey: [...orpc.clipper.listTokens.key(), server, userId],
			retry: false,
		}),
	);
	const revoke = useMutation({
		mutationKey: ["settings", "revoke-clipper-sign-in"],
		mutationFn: async (id: string) => {
			const result = await client.clipper.revokeToken({ id });
			if (!result.revoked) throw new Error("Sign-in revocation rejected");
		},
		onSuccess: () => {
			setSelected(null);
			showToast({ message: t`Sign-in revoked. The extension stops working on its next request.` });
			void queryClient.invalidateQueries({ queryKey: orpc.clipper.listTokens.key() });
		},
		onError: () => {
			setSelected(null);
			showToast({ message: t`Couldn't revoke the sign-in. Try again.` });
		},
	});
	const date = (value: string | null) => (value ? i18n.date(new Date(value), { dateStyle: "medium" }) : t`Never`);
	return (
		<SettingsGroup
			title={t`Job Clipper sign-ins`}
			note={t`Browsers where you signed in to the Job Clipper extension. You sign in from the extension on a computer.`}
		>
			{tokens.isPending ? <ListRow title={t`Loading sign-ins…`} /> : null}
			{tokens.isError ? (
				<Banner
					tone="danger"
					message={t`Couldn't load your Job Clipper sign-ins.`}
					action={{ label: t`Try again`, onPress: () => void tokens.refetch() }}
				/>
			) : null}
			{tokens.data?.length === 0 ? <EmptyState title={t`No Job Clipper sign-ins yet.`} /> : null}
			{tokens.data?.map((token) => (
				<ListRow
					key={token.id}
					title={`${token.organizationName} · ${token.label}`}
					subtitle={t`Signed in ${date(token.createdAt)} · Last used ${date(token.lastUsedAt)}`}
					leading="plugs-connected"
					trailing={<Text color="dangerText">{t`Revoke`}</Text>}
					accessibilityHint={t`Revoke this Job Clipper sign-in`}
					disabled={revoke.isPending}
					onPress={() => setSelected({ id: token.id, label: `${token.organizationName} · ${token.label}` })}
				/>
			))}
			<ConfirmDialog
				open={selected !== null}
				title={t`Revoke Job Clipper sign-in?`}
				message={t`“${selected?.label ?? ""}” stops working. You can sign in again from the extension.`}
				confirmLabel={t`Revoke sign-in`}
				destructive
				onCancel={() => setSelected(null)}
				onConfirm={() => {
					if (selected && !revoke.isPending) revoke.mutate(selected.id);
				}}
			/>
		</SettingsGroup>
	);
}
