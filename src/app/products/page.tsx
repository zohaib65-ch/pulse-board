import type { Metadata } from "next";
import { ProductsPage } from "@/components/dashboard/products-page";

export const metadata: Metadata = { title: "Products" };

export default function Page() {
  return <ProductsPage />;
}
