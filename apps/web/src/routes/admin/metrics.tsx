import { createFileRoute } from "@tanstack/react-router";
import { MetricsPage } from "@/features/platform-admin/metrics-page";

export const Route = createFileRoute("/admin/metrics")({ component: MetricsPage });
