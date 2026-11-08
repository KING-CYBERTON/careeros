import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminLayout } from "@/features/platform-admin/layout";
import { createNoindexFollowMeta } from "@/libs/seo";

// CAREEROS (P3-T07): the Super Admin console. Platform host only (the server answers 404 elsewhere); the layout shows
// "not found" to a user who is not an admin and the two-factor notice to an admin without it.
export const Route = createFileRoute("/admin")({
	component: AdminLayout,
	beforeLoad: ({ context, location }) => {
		if (!context.session) throw redirect({ to: "/auth/login", search: { callbackURL: location.href }, replace: true });
		return { session: context.session };
	},
	head: () => ({ meta: [createNoindexFollowMeta()] }),
});
