import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@reactive-resume/ui/components/icon";
import { cn } from "@reactive-resume/utils/style";
import { orpc } from "@/libs/orpc/client";

/**
 * CAREEROS (P3-T07, requirement 4): the platform's announcements that apply to this member in this organization and that
 * they have not dismissed. Plain text only (React escapes it). Dismissing is per user.
 */
export function AnnouncementBanner() {
	const queryClient = useQueryClient();
	const query = useQuery({ ...orpc.announcements.active.queryOptions(), refetchInterval: 5 * 60_000 });
	const dismiss = useMutation(
		orpc.announcements.dismiss.mutationOptions({
			onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.announcements.active.key() }),
		}),
	);
	if (!query.data || query.data.length === 0) return null;

	return (
		<div className="grid gap-px" data-testid="announcement-banner">
			{query.data.map((announcement) => (
				<div
					key={announcement.id}
					role="status"
					className={cn(
						"flex w-full items-start gap-2.5 px-4 py-2.5 text-[13px] leading-[19px]",
						announcement.severity === "warning" ? "bg-warn-soft text-warn-text" : "bg-info-soft text-info-text",
					)}
				>
					<Icon
						name={announcement.severity === "warning" ? "warning-circle" : "info"}
						size={18}
						className="mt-px shrink-0"
					/>
					<p className="min-w-0 flex-1 break-words whitespace-pre-wrap">
						<strong className="font-semibold">{announcement.title}</strong> {announcement.body}
					</p>
					<button
						type="button"
						aria-label={t`Dismiss announcement`}
						className="shrink-0 rounded-sm p-0.5 hover:bg-black/10"
						onClick={() => dismiss.mutate({ id: announcement.id })}
					>
						<Icon name="x" size={16} />
					</button>
				</div>
			))}
		</div>
	);
}
