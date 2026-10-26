import { Eye, MousePointerClick, ShoppingCart, type LucideIcon } from "lucide-react";
import type { EventType } from "@/shared/constants";

/** One visual identity per event type, used everywhere (chart, badges, buttons). Color follows the entity. */
export const EVENT_STYLE: Record<EventType, { label: string; plural: string; color: string; icon: LucideIcon }> = {
  page_view: { label: "Page view", plural: "Page views", color: "var(--chart-1)", icon: Eye },
  product_click: { label: "Product click", plural: "Product clicks", color: "var(--chart-2)", icon: MousePointerClick },
  add_to_cart: { label: "Cart addition", plural: "Cart additions", color: "var(--chart-3)", icon: ShoppingCart },
};
