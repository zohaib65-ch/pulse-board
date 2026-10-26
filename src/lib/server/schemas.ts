import { z } from "zod";
import { DEFAULT_RANGE, EVENT_TYPES, QUERY_LIMITS, RANGE_KEYS } from "@/shared/constants";
import { PRODUCT_SORT_KEYS } from "@/shared/api";
import { pageSchema, productIdSchema } from "@/shared/event-schema";

/** Query-string schemas. Every parameter is optional and has a bounded range. */

const intParam = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);

const rangeParam = z
  .enum(RANGE_KEYS)
  .optional()
  .transform((value) => value ?? DEFAULT_RANGE);

export const overviewQuery = z.strictObject({ range: rangeParam });

/** Comma-separated event ids for a direct lookup ("has the analytics consumer stored these yet?"). */
const idsParam = z
  .string()
  .max(QUERY_LIMITS.eventsLookupMaxIds * 37)
  .transform((value) => value.split(",").filter(Boolean))
  .pipe(z.array(z.uuid()).min(1).max(QUERY_LIMITS.eventsLookupMaxIds))
  .optional();

export const eventsQuery = z.strictObject({
  range: rangeParam,
  ids: idsParam,
  type: z.enum(EVENT_TYPES).optional(),
  page: pageSchema.optional(),
  productId: productIdSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: intParam(1, QUERY_LIMITS.eventsMaxPageSize, QUERY_LIMITS.eventsDefaultPageSize),
});

export const productsQuery = z.strictObject({
  range: rangeParam,
  q: z
    .string()
    .max(QUERY_LIMITS.maxSearchLength)
    .optional()
    .transform((value) => (value ?? "").trim()),
  sort: z
    .enum(PRODUCT_SORT_KEYS)
    .optional()
    .transform((value) => value ?? "clicks"),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .transform((value) => value ?? "desc"),
  page: intParam(1, 10_000, 1),
  pageSize: intParam(1, QUERY_LIMITS.productsMaxPageSize, QUERY_LIMITS.productsDefaultPageSize),
});

export const alertsQuery = z.strictObject({
  limit: intParam(1, QUERY_LIMITS.alertsMaxLimit, QUERY_LIMITS.alertsDefaultLimit),
});

/** Replay creation takes no parameters; the body must be an empty object. */
export const replayCreateBody = z.strictObject({});
