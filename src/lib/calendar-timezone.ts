import { Temporal } from "@js-temporal/polyfill";

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Date objects in the calendar are date-only UI values represented at local noon. */
export function calendarDateKey(day: Date): string {
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

export function calendarDateKeyForInstant(instant: string, timezone: string): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

export function calendarDayFromDateKey(value: string): Date {
  const match = DATE_KEY.exec(value);
  if (!match) throw new RangeError("invalid calendar date");
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (calendarDateKey(day) !== value) throw new RangeError("invalid calendar date");
  return day;
}

export function calendarDayForInstant(instant: string, timezone: string): Date {
  return calendarDayFromDateKey(calendarDateKeyForInstant(instant, timezone));
}
