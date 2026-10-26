import { Activity, FlaskConical, LayoutDashboard, Package, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

export const DASHBOARD_NAV: NavItem[] = [
  { title: "Overview", href: "/", icon: LayoutDashboard },
  { title: "Live events", href: "/events", icon: Activity },
  { title: "Products", href: "/products", icon: Package },
];

export const LEARN_NAV: NavItem[] = [{ title: "Kafka Lab", href: "/lab", icon: FlaskConical }];

export const SETTINGS_NAV: NavItem = { title: "Settings", href: "/settings", icon: Settings };
