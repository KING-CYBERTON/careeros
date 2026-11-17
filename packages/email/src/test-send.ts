import { createElement } from "react";
import { TEST_EMAIL_SUBJECT, TestEmail } from "./templates/test-email";
import { type DeliveryResult, deliverEmail } from "./transport";

// CAREEROS (P6-T02): the Super Admin console's test send. The caller passes the signed-in admin's own address; there is
// no recipient input anywhere above this function. The message is fixed, in the platform's own name, with no reply-to.

export const sendTestEmail = (to: string): Promise<DeliveryResult> =>
	deliverEmail({ to, subject: TEST_EMAIL_SUBJECT, react: createElement(TestEmail) });
