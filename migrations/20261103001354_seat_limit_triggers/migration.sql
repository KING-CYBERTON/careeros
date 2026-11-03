-- CAREEROS P3-T02 (review 1): the seat limit is enforced by the database, so no path can add a member or a pending
-- invitation past it, however many requests arrive at once. The TypeScript checks stay for a friendly early error.
--
-- A BEFORE INSERT trigger on "member" and on "invitation" (pending rows only) takes a transaction-scoped advisory lock
-- on the organization, so two inserts for the same organization run one after the other. Under READ COMMITTED each
-- statement of the function then sees every row the previous holder committed. It counts members plus pending
-- invitations that have not expired (the same `seatsUsed` as getEntitlements) and refuses one more when that would pass
-- the effective seat limit.
--
-- The effective limit mirrors `effectiveSeatLimit` in packages/billing/src/entitlements.ts (Q194): the seats the
-- organization pays for (subscription.seats) while the subscription is live (status active, trialing or past_due with a
-- provider other than 'none'), otherwise the plan's seat_limit. A null limit is unlimited. An organization with no
-- subscription row, or no plan row, is not limited by this trigger (the TypeScript side reports a missing plan).
--
-- Accepting an invitation stays a swap. Better Auth marks the invitation accepted first and inserts the member
-- second, so when the member row arrives the invitation no longer counts as pending and the member takes its seat.
-- If the member insert fails Better Auth puts the invitation back to pending.
--
-- Who is checked: only sessions whose login role is careeros_app, the application. The owner role (migrations, platform
-- functions, test seeding) is not limited, like the plan guard of P3-T01. session_user, not current_user, because the
-- function is SECURITY DEFINER (it must read plan, subscription and the other members under row level security).
--
-- The refusal is SQLSTATE 'CS001' with the message 'careeros_seat_limit_reached'; the TypeScript callers map it to
-- SEAT_LIMIT_REACHED.
CREATE OR REPLACE FUNCTION public.careeros_enforce_seat_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	plan_limit integer;
	plan_found boolean;
	sub_status text;
	sub_provider text;
	sub_seats integer;
	seat_limit integer;
	used integer;
BEGIN
	IF session_user <> 'careeros_app' THEN
		RETURN NEW;
	END IF;
	PERFORM pg_advisory_xact_lock(hashtextextended('careeros_seats:' || NEW.organization_id, 0));
	SELECT p.seat_limit, true INTO plan_limit, plan_found
		FROM public.organization o JOIN public.plan p ON p.id = o.plan_id WHERE o.id = NEW.organization_id;
	IF plan_found IS NOT TRUE THEN
		RETURN NEW;
	END IF;
	SELECT s.status, s.provider, s.seats INTO sub_status, sub_provider, sub_seats
		FROM public.subscription s WHERE s.organization_id = NEW.organization_id;
	IF sub_status IN ('active', 'trialing', 'past_due') AND sub_provider <> 'none' THEN
		seat_limit := sub_seats;
	ELSE
		seat_limit := plan_limit;
	END IF;
	IF seat_limit IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT (SELECT count(*) FROM public.member m WHERE m.organization_id = NEW.organization_id)
		+ (SELECT count(*) FROM public.invitation i
			WHERE i.organization_id = NEW.organization_id AND i.status = 'pending' AND i.expires_at > now())
		INTO used;
	IF used + 1 > seat_limit THEN
		RAISE EXCEPTION 'careeros_seat_limit_reached' USING ERRCODE = 'CS001';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "careeros_member_seat_limit" ON "member";--> statement-breakpoint
CREATE TRIGGER "careeros_member_seat_limit" BEFORE INSERT ON "member"
	FOR EACH ROW EXECUTE FUNCTION public.careeros_enforce_seat_limit();--> statement-breakpoint
DROP TRIGGER IF EXISTS "careeros_invitation_seat_limit" ON "invitation";--> statement-breakpoint
CREATE TRIGGER "careeros_invitation_seat_limit" BEFORE INSERT ON "invitation"
	FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION public.careeros_enforce_seat_limit();
