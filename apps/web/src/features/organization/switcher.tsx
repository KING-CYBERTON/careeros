import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { toast } from "@reactive-resume/ui/components/toast";
import { cn } from "@reactive-resume/utils/style";
import { useActiveOrganizationId, useOrganizations } from "./queries";
import { authClient } from "@/libs/auth/client";
import { getReadableErrorMessage } from "@/libs/error-message";

type OrganizationSwitcherProps = { className?: string };

/** Switches the active organization. Shown only to people who belong to two or more. */
export function OrganizationSwitcher({ className }: OrganizationSwitcherProps) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const activeOrganizationId = useActiveOrganizationId();
	const { data: organizations } = useOrganizations();

	if (!organizations || organizations.length < 2) return null;

	const switchTo = async (organizationId: string) => {
		if (organizationId === activeOrganizationId) return;
		const { error } = await authClient.organization.setActive({ organizationId });
		if (error) {
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't switch organization. Try again.`),
			});
			return;
		}
		// Everything cached belongs to the previous organization.
		await queryClient.invalidateQueries();
		await router.invalidate();
	};

	return (
		<NativeSelect
			aria-label={t`Organization`}
			className={cn("h-[34px] text-sm", className)}
			value={activeOrganizationId ?? ""}
			onChange={(event) => void switchTo(event.target.value)}
		>
			{organizations.map((organization) => (
				<option key={organization.id} value={organization.id}>
					{organization.name}
				</option>
			))}
		</NativeSelect>
	);
}
