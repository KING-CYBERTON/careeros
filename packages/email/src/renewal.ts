import type { RenewalReminderCopy } from "./billing-strings";
import type { EmailBrand } from "./brand";
import { createElement } from "react";
import { RenewalReminderEmail } from "./templates/auth";

// CAREEROS (P3-T05): builds the renewal reminder message (subject and body). It lives here, not in the API package,
// because building the body needs React, which only this package has. The caller sends it with `sendEmail`.

export type RenewalReminderMessageOptions = {
	url: string;
	copy: RenewalReminderCopy;
	brand?: EmailBrand | undefined;
};

export const renewalReminderMessage = ({ url, copy, brand }: RenewalReminderMessageOptions) => ({
	subject: copy.subject,
	react: createElement(RenewalReminderEmail, { url, copy, brand }),
});
