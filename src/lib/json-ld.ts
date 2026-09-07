/** JSON remains data inside an HTML script element, including nested external strings. */
export function serializeJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}
