import type { EmailBrand } from "./brand";
import { cleanAppName } from "./brand";

// CAREEROS (P2-T04): subject lines name the organization's product. The name is cleaned of control characters, so a
// subject can never carry a line break.

export const resetPasswordSubject = (brand?: EmailBrand) => `Reset your ${cleanAppName(brand?.appName)} password`;
export const verifyEmailSubject = (brand?: EmailBrand) => `Verify your email for ${cleanAppName(brand?.appName)}`;
export const verifyEmailChangeSubject = (brand?: EmailBrand) =>
	`Approve your ${cleanAppName(brand?.appName)} email change`;
export const invitationSubject = (organizationName: string, brand?: EmailBrand) =>
	`Join ${cleanAppName(organizationName)} on ${cleanAppName(brand?.appName)}`;
