import { createFileRoute } from "@tanstack/react-router";
import { DiscoveryReviewQueue } from "@/features/discovery/review-queue";
import { DiscoverySearches } from "@/features/discovery/searches";

// CAREEROS (P4-T03): the searches section sits above the review queue.
function DiscoveryPage() {
	return (
		<div className="grid gap-8">
			<DiscoverySearches />
			<DiscoveryReviewQueue />
		</div>
	);
}

export const Route = createFileRoute("/dashboard/career/jobs")({
	component: DiscoveryPage,
});
