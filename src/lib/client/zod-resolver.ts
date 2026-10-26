import type { FieldErrors, FieldValues, Resolver } from "react-hook-form";
import type { ZodType } from "zod";

/**
 * Minimal Zod → React Hook Form resolver (`@hookform/resolvers` is not installed).
 * Supports nested field paths; one error message per field (the first issue wins).
 */
export function zodResolver<TFieldValues extends FieldValues>(schema: ZodType<TFieldValues, TFieldValues>): Resolver<TFieldValues> {
  return async (values) => {
    const result = await schema.safeParseAsync(values);
    if (result.success) return { values: result.data, errors: {} };

    const errors: Record<string, unknown> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.map(String);
      if (path.length === 0) path.push("root");
      let cursor = errors;
      path.forEach((segment, index) => {
        if (index === path.length - 1) {
          if (!(segment in cursor)) cursor[segment] = { type: issue.code, message: issue.message };
        } else {
          cursor[segment] = (cursor[segment] as Record<string, unknown> | undefined) ?? {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
      });
    }
    return { values: {}, errors: errors as FieldErrors<TFieldValues> };
  };
}
