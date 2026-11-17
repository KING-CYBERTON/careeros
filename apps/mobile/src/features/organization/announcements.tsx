// CAREEROS (P3-T07, requirement 4): the platform's announcements for this member, on the home screen, the same as the web
// banner. The server decides which announcements apply (window, plan, organization, membership) and remembers each
// dismissal per user. The Super Admin console itself is web only (see docs/UPSTREAM_PATCHES.md, Mobile parity gaps).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { View } from "react-native";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { Banner, useTheme } from "@/ui";

/** Announcements that apply to the member, keyed by server so one server's answer never carries over to another. */
export function useAnnouncements() {
	const { server, status } = useSession();
	return useQuery({
		...orpc.announcements.active.queryOptions(),
		queryKey: [...orpc.announcements.active.key(), server],
		enabled: status === "signed-in",
		retry: false,
		staleTime: 60_000,
	});
}

/** One banner per announcement. Dismissing hides it for this member only. Plain text, as sent. */
export function AnnouncementBanners() {
	const queryClient = useQueryClient();
	const { space } = useTheme();
	const { data } = useAnnouncements();
	const dismiss = useMutation(
		orpc.announcements.dismiss.mutationOptions({
			onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.announcements.active.key() }),
		}),
	);
	if (!data || data.length === 0) return null;
	return (
		<View style={{ gap: space.s2 }}>
			{data.map((announcement) => (
				<Banner
					key={announcement.id}
					tone={announcement.severity === "warning" ? "warn" : "info"}
					icon={announcement.severity === "warning" ? "warning-circle" : "info"}
					title={announcement.title}
					message={announcement.body}
					onDismiss={() => dismiss.mutate({ id: announcement.id })}
				/>
			))}
		</View>
	);
}
