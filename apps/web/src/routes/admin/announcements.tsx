import { createFileRoute } from "@tanstack/react-router";
import { AnnouncementsPage } from "@/features/platform-admin/announcements-page";

export const Route = createFileRoute("/admin/announcements")({ component: AnnouncementsPage });
