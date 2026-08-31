type CalendarRecordIdentity = Readonly<{
  serverDraftId?: number;
  publicationOperationId?: number;
  operationStatus?: string;
}>;

/**
 * A scheduled publication and its editable draft point at the same content lineage.
 * Keep the publication card as the single calendar entry so opening it always carries
 * the operation id required for safe replacement/rescheduling.
 */
export function collapsePublishedDraftDuplicates<T extends CalendarRecordIdentity>(
  records: readonly T[],
): T[] {
  const activePublicationDraftIds = new Set(
    records
      .filter((record) => (
        record.serverDraftId != null
        && record.publicationOperationId != null
        && record.operationStatus !== "cancelled"
      ))
      .map((record) => record.serverDraftId as number),
  );

  return records.filter((record) => !(
    record.serverDraftId != null
    && record.publicationOperationId == null
    && activePublicationDraftIds.has(record.serverDraftId)
  ));
}

export function activePublicationOperationForDraft<T extends CalendarRecordIdentity>(
  records: readonly T[],
  draftId: number,
): number | null {
  const match = records.find((record) => (
    record.serverDraftId === draftId
    && record.publicationOperationId != null
    && record.operationStatus !== "cancelled"
  ));
  return match?.publicationOperationId ?? null;
}
