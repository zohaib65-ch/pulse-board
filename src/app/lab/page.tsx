import type { Metadata } from "next";
import { LabPage } from "@/components/dashboard/lab/lab-page";

export const metadata: Metadata = { title: "Kafka Lab" };

export default function Page() {
  return <LabPage />;
}
