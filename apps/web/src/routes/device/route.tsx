import { createFileRoute } from "@tanstack/react-router";
import { AuthLayout } from "@/features/auth/layout";
import { createNoindexFollowMeta } from "@/libs/seo";

// CAREEROS (P5-T02): `/device`, where a member approves the Job Clipper's sign-in. Same look as the sign-in pages.
export const Route = createFileRoute("/device")({
	component: AuthLayout,
	head: () => ({
		meta: [createNoindexFollowMeta()],
	}),
});
