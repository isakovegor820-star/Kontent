import {
  inspectLocalSchedule,
  localScheduleFieldsForInstant,
  resolveLocalSchedule,
  ScheduleValidationError,
  type ScheduleDisambiguation,
} from "./timezone-schedule";
import { calendarDateKey } from "./calendar-timezone";

export function resolveCalendarDayMove(input: {
  scheduledAt: string;
  targetDay: Date;
  timezone: string;
  disambiguation?: ScheduleDisambiguation | null;
  offset?: string | null;
}) {
  const current = localScheduleFieldsForInstant(input.scheduledAt, input.timezone);
  const localDate = calendarDateKey(input.targetDay);
  const inspected = inspectLocalSchedule({
    localDate,
    localTime: current.localTime,
    timezone: input.timezone,
  });
  if (inspected.kind === "nonexistent") {
    throw new ScheduleValidationError("nonexistent_local_time");
  }
  if (inspected.kind === "invalid_timezone" || inspected.kind === "invalid_local_time") {
    throw new ScheduleValidationError(inspected.kind);
  }
  let disambiguation: ScheduleDisambiguation = "reject";
  if (inspected.kind === "ambiguous") {
    if (input.disambiguation === "earlier" || input.disambiguation === "later") {
      disambiguation = input.disambiguation;
    } else if (input.offset === inspected.earlier.offset) {
      disambiguation = "earlier";
    } else if (input.offset === inspected.later.offset) {
      disambiguation = "later";
    } else {
      throw new ScheduleValidationError("ambiguous_local_time");
    }
  }
  return resolveLocalSchedule({
    localDate,
    localTime: current.localTime,
    timezone: input.timezone,
    disambiguation,
  });
}
