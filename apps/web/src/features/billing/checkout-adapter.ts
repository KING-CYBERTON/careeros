import type { PaymentMethod } from "./lib";
import type { client } from "@/libs/orpc/client";

// CAREEROS (P3-T06): the one place that knows whether `billing.checkout` takes a payment `method`. P3-T05 (the Paystack
// provider) owns that API change. Until it is on this branch the selector stays hidden and nothing is sent; the type
// below stops compiling the day the API gains the argument, which is the signal to turn the flag on (Q480).

type CheckoutInput = Parameters<typeof client.billing.checkout>[0];

type ApiTakesMethod = "method" extends keyof CheckoutInput ? true : false;

/** Set to `true` when `billing.checkout` accepts `method`; the compiler says when (it then rejects `false`). */
export const API_TAKES_METHOD: ApiTakesMethod = false;

export type CheckoutRequest = Omit<CheckoutInput, "method">;

/** The input for `billing.checkout`: the request, plus `method` when the API takes it. */
export function toCheckoutInput(request: CheckoutRequest, method: PaymentMethod): CheckoutInput {
	return API_TAKES_METHOD ? ({ ...request, method } as CheckoutInput) : request;
}

/** Whether the payment-method selector is shown. */
export const methodSelectable = (): boolean => API_TAKES_METHOD;
