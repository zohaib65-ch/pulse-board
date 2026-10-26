import { requestDb } from "@/lib/server/context";
import { ok, parseQuery, route } from "@/lib/server/http";
import { getProducts } from "@/lib/server/queries/products";
import { productsQuery } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  const query = parseQuery(request, productsQuery);
  const db = await requestDb();
  return ok(await getProducts(db, query));
});
