import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import z from "zod";
import { DevicePage } from "@/features/auth/pages/device";

// CAREEROS (P5-T02): signed-out visitors sign in first (on this address, with this address's session), then return here
// with the code intact.
export const Route = createFileRoute("/device/")({
	validateSearch: z.object({ user_code: z.string().max(32).catch("") }),
	beforeLoad: ({ context, location }) => {
		if (!context.session) {
			throw redirect({ to: "/auth/login", search: { callbackURL: `${location.pathname}${location.searchStr}` } });
		}
		return { session: context.session };
	},
	component: RouteComponent,
});

function RouteComponent() {
	const { session } = Route.useRouteContext();
	const { user_code: userCode } = Route.useSearch();
	const navigate = useNavigate();
	return (
		<DevicePage
			key={userCode}
			userCode={userCode}
			email={session.user.email}
			onCode={(code) => void navigate({ to: "/device", search: { user_code: code }, replace: true })}
		/>
	);
}
