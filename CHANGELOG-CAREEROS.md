## Unreleased

- Phase 0 setup started from Reactive Resume v6.0.10 (a69e483)
- P1-T03: personal organization at signup, invitations (accept page), organization switcher and Members & invites settings
- P2-T03: the request host decides the organization (`ORG_HOST_PATTERN`), join or switch page, sign-up on organization hosts
- P2-T02: each organization's name, logo, favicon, colours and font are served in the app shell, the manifest and the mobile app; unknown organization addresses show a "not set up yet" page
- P2-T05: social and OIDC sign-in on organization hosts through a one-time, host-bound handoff (`/api/careeros/handoff/*`, `/auth/handoff` pages)
- P2-T04: every email (invitation, verify, reset, change-email, career notification) is sent in the organization's brand, with its sender name and reply-to; links stay on the host the flow started on
- P2-T06: organizations serve the product on their own domain (`organization_domain`, TXT verification, Cloudflare for SaaS, daily takeover check); `hasOpenSignup` answered by a definer function (Q94)
- P2-C01: staging serves organization hosts and custom domains through the tunnel (`infra/staging/cloudflare.mjs`, `careeros-staging-cloudflare` workflow, optional organization host check after deploy)
- P2-T07: owners and admins manage the organization's brand and custom domains from Settings → Branding and Domains on web and mobile; logo and favicon can be removed; the mobile sign-in screen is branded from the server address (`GET /branding/host`)
