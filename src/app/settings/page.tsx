import type { Metadata } from "next";
import { SettingsPage } from "@/components/dashboard/settings/settings-page";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <SettingsPage />;
}
