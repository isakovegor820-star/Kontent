import { Temporal } from "@js-temporal/polyfill";

export type ScheduleDisambiguation = "reject" | "earlier" | "later";

export interface LocalScheduleInput {
  localDate: string;
  localTime: string;
  timezone: string;
  disambiguation: ScheduleDisambiguation;
  offset?: string | null;
}

export type LocalScheduleInspection =
  | { kind: "valid"; scheduledAt: string; offset: string; disambiguation: "reject" }
  | {
      kind: "ambiguous";
      earlier: { scheduledAt: string; offset: string };
      later: { scheduledAt: string; offset: string };
    }
  | { kind: "nonexistent" }
  | { kind: "invalid_timezone" }
  | { kind: "invalid_local_time" };

export class ScheduleValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ScheduleValidationError";
  }
}

function parsePlainDateTime(localDate: string, localTime: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate) || !/^\d{2}:\d{2}$/u.test(localTime)) {
    throw new ScheduleValidationError("invalid_local_time");
  }
  try {
    return Temporal.PlainDateTime.from(`${localDate}T${localTime}:00`, { overflow: "reject" });
  } catch {
    throw new ScheduleValidationError("invalid_local_time");
  }
}

function candidate(plain: Temporal.PlainDateTime, timezone: string, disambiguation: "earlier" | "later") {
  return Temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: plain.year,
    month: plain.month,
    day: plain.day,
    hour: plain.hour,
    minute: plain.minute,
    second: 0,
  }, { disambiguation });
}

const instantIso = (value: Temporal.ZonedDateTime) => new Date(value.epochMilliseconds).toISOString();

export function inspectLocalSchedule(input: Pick<LocalScheduleInput, "localDate" | "localTime" | "timezone">): LocalScheduleInspection {
  let plain: Temporal.PlainDateTime;
  try {
    plain = parsePlainDateTime(input.localDate, input.localTime);
  } catch {
    return { kind: "invalid_local_time" };
  }
  let earlier: Temporal.ZonedDateTime;
  let later: Temporal.ZonedDateTime;
  try {
    earlier = candidate(plain, input.timezone, "earlier");
    later = candidate(plain, input.timezone, "later");
  } catch {
    return { kind: "invalid_timezone" };
  }
  const earlierMatches = earlier.toPlainDateTime().equals(plain);
  const laterMatches = later.toPlainDateTime().equals(plain);
  if (!earlierMatches && !laterMatches) return { kind: "nonexistent" };
  const earlierResult = { scheduledAt: instantIso(earlier), offset: earlier.offset };
  const laterResult = { scheduledAt: instantIso(later), offset: later.offset };
  if (earlier.epochNanoseconds !== later.epochNanoseconds && earlierMatches && laterMatches) {
    return { kind: "ambiguous", earlier: earlierResult, later: laterResult };
  }
  return {
    kind: "valid",
    scheduledAt: earlierMatches ? earlierResult.scheduledAt : laterResult.scheduledAt,
    offset: earlierMatches ? earlierResult.offset : laterResult.offset,
    disambiguation: "reject",
  };
}

export function resolveLocalSchedule(input: LocalScheduleInput, claimedInstant?: string | null) {
  const inspected = inspectLocalSchedule(input);
  if (inspected.kind === "invalid_timezone") throw new ScheduleValidationError("invalid_timezone");
  if (inspected.kind === "invalid_local_time") throw new ScheduleValidationError("invalid_local_time");
  if (inspected.kind === "nonexistent") throw new ScheduleValidationError("nonexistent_local_time");
  let resolved: { scheduledAt: string; offset: string; disambiguation: ScheduleDisambiguation };
  if (inspected.kind === "ambiguous") {
    if (input.disambiguation !== "earlier" && input.disambiguation !== "later") {
      throw new ScheduleValidationError("ambiguous_local_time");
    }
    resolved = { ...inspected[input.disambiguation], disambiguation: input.disambiguation };
  } else {
    resolved = inspected;
  }
  if (input.offset && input.offset !== resolved.offset) {
    throw new ScheduleValidationError("schedule_offset_conflict");
  }
  if (claimedInstant) {
    let claimed: string;
    try {
      claimed = new Date(Temporal.Instant.from(claimedInstant).epochMilliseconds).toISOString();
    } catch {
      throw new ScheduleValidationError("bad_time");
    }
    if (claimed !== resolved.scheduledAt) throw new ScheduleValidationError("schedule_instant_conflict");
  }
  return {
    ...resolved,
    localDate: input.localDate,
    localTime: input.localTime,
    timezone: input.timezone,
  };
}

export function localScheduleFieldsForInstant(scheduledAt: string, timezone: string) {
  let zoned: Temporal.ZonedDateTime;
  try {
    zoned = Temporal.Instant.from(scheduledAt).toZonedDateTimeISO(timezone);
  } catch {
    throw new ScheduleValidationError("invalid_schedule");
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    localDate: `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`,
    localTime: `${pad(zoned.hour)}:${pad(zoned.minute)}`,
    timezone,
    offset: zoned.offset,
  };
}
