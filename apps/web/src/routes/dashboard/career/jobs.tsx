import { createFileRoute } from "@tanstack/react-router";
import { DiscoveryReviewQueue } from "@/features/discovery/review-queue";

export const Route = createFileRoute("/dashboard/career/jobs")({
	component: DiscoveryReviewQueue,
});
