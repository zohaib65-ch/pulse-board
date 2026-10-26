/**
 * The demo storefront the synthetic traffic pretends to browse.
 * Product ids are stable slugs; names are display-only.
 */
export const PRODUCTS = [
  { id: "aurora-desk-lamp", name: "Aurora Desk Lamp" },
  { id: "basalt-coffee-mug", name: "Basalt Coffee Mug" },
  { id: "cedar-notebook", name: "Cedar Notebook" },
  { id: "drift-wireless-speaker", name: "Drift Wireless Speaker" },
  { id: "ember-wool-throw", name: "Ember Wool Throw" },
  { id: "fjord-water-bottle", name: "Fjord Water Bottle" },
  { id: "grove-plant-pot", name: "Grove Plant Pot" },
  { id: "harbor-canvas-tote", name: "Harbor Canvas Tote" },
] as const;

export type ProductId = (typeof PRODUCTS)[number]["id"];

export const PAGES = [
  { path: "/", label: "Home" },
  { path: "/products", label: "Product list" },
  ...PRODUCTS.map((p) => ({ path: `/products/${p.id}`, label: p.name })),
  { path: "/cart", label: "Cart" },
  { path: "/checkout", label: "Checkout" },
] as const;

const PRODUCT_NAMES: Record<string, string> = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.name]));

/** Display name for a product id; unknown ids are shown as-is. */
export function productName(productId: string): string {
  return PRODUCT_NAMES[productId] ?? productId;
}
