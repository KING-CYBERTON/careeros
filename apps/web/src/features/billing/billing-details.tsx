import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";
import { useBillingProfile } from "./queries";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T10): the customer details printed on every invoice. The owner edits and saves; an admin sees them
// read-only. The server checks the role again; the UI only disables what it would refuse.

export type BillingDetailsValues = {
	legalName: string | null;
	address: string | null;
	taxPin: string | null;
	billingEmail: string | null;
};

type BillingDetailsFormProps = { initial: BillingDetailsValues; canEdit: boolean };

function BillingDetailsForm({ initial, canEdit }: BillingDetailsFormProps) {
	const ids = { name: useId(), address: useId(), pin: useId(), email: useId() };
	const queryClient = useQueryClient();
	const [legalName, setLegalName] = useState(initial.legalName ?? "");
	const [address, setAddress] = useState(initial.address ?? "");
	const [taxPin, setTaxPin] = useState(initial.taxPin ?? "");
	const [billingEmail, setBillingEmail] = useState(initial.billingEmail ?? "");
	const save = useMutation(
		orpc.billing.updateProfile.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Billing details saved.` });
				await queryClient.invalidateQueries({ queryKey: orpc.billing.key() });
			},
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't save the billing details.`),
				}),
		}),
	);
	const changed =
		legalName !== (initial.legalName ?? "") ||
		address !== (initial.address ?? "") ||
		taxPin !== (initial.taxPin ?? "") ||
		billingEmail !== (initial.billingEmail ?? "");

	return (
		<form
			className="grid gap-4 sm:max-w-xl"
			data-testid="billing-details-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (canEdit && changed) save.mutate({ legalName, address, taxPin, billingEmail });
			}}
		>
			<div className="grid gap-1.5">
				<Label htmlFor={ids.name}>
					<Trans>Legal name</Trans>
				</Label>
				<Input
					id={ids.name}
					value={legalName}
					maxLength={200}
					disabled={!canEdit}
					autoComplete="organization"
					onChange={(event) => setLegalName(event.target.value)}
				/>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={ids.address}>
					<Trans>Address</Trans>
				</Label>
				<Textarea
					id={ids.address}
					value={address}
					rows={3}
					maxLength={500}
					disabled={!canEdit}
					autoComplete="street-address"
					onChange={(event) => setAddress(event.target.value)}
				/>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="grid gap-1.5">
					<Label htmlFor={ids.pin}>
						<Trans>KRA PIN</Trans>
					</Label>
					<Input
						id={ids.pin}
						value={taxPin}
						maxLength={32}
						disabled={!canEdit}
						onChange={(event) => setTaxPin(event.target.value)}
					/>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor={ids.email}>
						<Trans>Billing email</Trans>
					</Label>
					<Input
						id={ids.email}
						type="email"
						value={billingEmail}
						maxLength={254}
						disabled={!canEdit}
						autoComplete="email"
						onChange={(event) => setBillingEmail(event.target.value)}
					/>
				</div>
			</div>
			{canEdit ? (
				<div>
					<Button type="submit" variant="secondary" disabled={save.isPending || !changed}>
						<Trans>Save billing details</Trans>
					</Button>
				</div>
			) : (
				<p className="text-[13px] text-ink-3" data-testid="billing-details-readonly">
					<Trans>Only the owner can change these details.</Trans>
				</p>
			)}
		</form>
	);
}

type BillingDetailsProps = { canEdit: boolean };

export function BillingDetails({ canEdit }: BillingDetailsProps) {
	const profile = useBillingProfile();
	return (
		<SettingsSection title={<Trans>Billing details</Trans>} description={<Trans>Printed on your invoices.</Trans>}>
			{profile.data ? (
				// A new key when the saved details change, so the form starts from what the server holds.
				<BillingDetailsForm
					key={profile.data.updatedAt?.getTime() ?? "none"}
					initial={profile.data}
					canEdit={canEdit}
				/>
			) : profile.error ? (
				<p className="text-sm text-ink-2" data-testid="billing-details-error">
					<Trans>Couldn't load the billing details.</Trans>
				</p>
			) : (
				<Skeleton className="h-40 rounded-xl" />
			)}
		</SettingsSection>
	);
}
