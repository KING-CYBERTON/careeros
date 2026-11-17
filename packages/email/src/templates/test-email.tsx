import * as React from "react";
import { Body, Container, Html, Preview, Text } from "react-email";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";

// ponytail: server dev consumes this source through tsx, which emits React.createElement here.
void React;

// CAREEROS (P6-T02): the fixed message of the Super Admin console's "Send test email". It carries no recipient, token or
// link, and no organization brand: it proves the platform's sender works, so it is always the platform's own.
export const TEST_EMAIL_SUBJECT = `Test email from ${PLATFORM_DEFAULT_APP_NAME}`;

export function TestEmail() {
	return (
		<Html lang="en">
			<Preview>This is a test message from the email settings.</Preview>
			<Body style={{ fontFamily: "sans-serif", margin: 0, padding: "24px" }}>
				<Container style={{ maxWidth: "480px" }}>
					<Text style={{ fontSize: "18px", fontWeight: 600 }}>Test email</Text>
					<Text>
						This is a test message from {PLATFORM_DEFAULT_APP_NAME}, sent from the Super Admin console. If you can read
						it, email delivery works.
					</Text>
				</Container>
			</Body>
		</Html>
	);
}
