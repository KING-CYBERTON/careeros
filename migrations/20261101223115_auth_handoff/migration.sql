CREATE TABLE "auth_handoff" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"target_origin" text NOT NULL,
	"return_to" text NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"user_id" text,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "auth_handoff_token_state_check" CHECK (("token_hash" is null) = ("token_expires_at" is null) and ("token_hash" is null) = ("user_id" is null))
);
--> statement-breakpoint
CREATE INDEX "auth_handoff_expires_at_idx" ON "auth_handoff" ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_handoff" ADD CONSTRAINT "auth_handoff_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_handoff" ADD CONSTRAINT "auth_handoff_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;