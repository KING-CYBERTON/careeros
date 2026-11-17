import type { BillingEvent } from "../events";
import { type BillingProvider, ProviderUnsupportedError } from "./types";

// CAREEROS (P3-T04): payments recorded by a platform admin (institutions that pay by invoice). There is no checkout, no
// portal and no webhook: the payment is applied by `careeros_record_manual_payment` (manual-payment.ts).

const unsupported = (operation: string) => Promise.reject(new ProviderUnsupportedError("manual", operation));

export const manualProvider: BillingProvider = {
	id: "manual",
	createCheckout: () => unsupported("checkout"),
	changeSeats: () => unsupported("changing seats"),
	cancel: () => unsupported("cancelling"),
	customerPortalUrl: () => Promise.resolve(null),
	verifyWebhook: (): Promise<BillingEvent> => unsupported("webhooks"),
};
