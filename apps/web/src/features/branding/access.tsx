import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { useBrandingAccess } from "./queries";

type RequireBrandingAdminProps = { children: ReactNode };

/**
 * CAREEROS (P2-T07): sends a member who is not an owner or admin back to Settings with a toast. This is a courtesy; the
 * API refuses them anyway.
 */
export function RequireBrandingAdmin({ children }: RequireBrandingAdminProps) {
	const { status } = useBrandingAccess();
	const navigate = useNavigate();

	useEffect(() => {
		if (status !== "denied") return;
		toast.add({ type: "error", description: t`Only owners and admins can change the organization's branding.` });
		void navigate({ to: "/dashboard/settings", replace: true });
	}, [status, navigate]);

	if (status !== "allowed") return <Skeleton className="h-40 rounded-xl" />;
	return children;
}
