export type CalendarTeamRecord = {
  authorUserId?: number;
  authorName?: string;
  calendarStatus?: string;
  status: string;
};

export function calendarRecordStatus(record: CalendarTeamRecord) {
  return record.calendarStatus || record.status;
}

export function calendarRecordIsVisible(record: CalendarTeamRecord) {
  return record.status !== "cancelled" && calendarRecordStatus(record) !== "cancelled";
}

export function calendarRecordMatches(
  record: CalendarTeamRecord,
  filters: { author: string; status: string },
) {
  return (
    (filters.author === "all" || record.authorUserId === Number(filters.author))
    && (filters.status === "all" || calendarRecordStatus(record) === filters.status)
  );
}

export function calendarAuthorOptions(records: readonly CalendarTeamRecord[]) {
  const authors = new Map<number, string>();
  for (const record of records) {
    if (!Number.isSafeInteger(record.authorUserId) || Number(record.authorUserId) <= 0) continue;
    const id = Number(record.authorUserId);
    authors.set(id, record.authorName?.trim() || `Участник ${id}`);
  }
  return [...authors.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
