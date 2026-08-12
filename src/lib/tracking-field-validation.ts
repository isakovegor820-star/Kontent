import { normalizeUtmValues, UTM_FIELDS, type UtmField, type UtmValues } from "./utm";

export type UtmFieldErrors = Partial<Record<UtmField, string>>;

/**
 * Mirrors the server normalization one field at a time so a form can identify and
 * focus the exact value that needs attention before sending a request.
 */
export function validateUtmFields(values: UtmValues): UtmFieldErrors {
  const errors: UtmFieldErrors = {};
  for (const field of UTM_FIELDS) {
    try {
      normalizeUtmValues({ [field]: values[field] ?? "" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      errors[field] = code.endsWith("_too_long")
        ? "Сократи значение до 160 символов."
        : "Убери электронную почту или телефон.";
    }
  }
  return errors;
}
