import type { Metadata } from "next";
import { EventsPage } from "@/components/dashboard/events-page";

export const metadata: Metadata = { title: "Live events" };

export default function Page() {
  return <EventsPage />;
}
