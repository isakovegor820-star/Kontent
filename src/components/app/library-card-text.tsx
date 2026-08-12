"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type LibraryCardKind = "hit" | "post" | "registry";

export function libraryCardContentId(kind: LibraryCardKind, id: number | string): string {
  return `library-${kind}-text-${String(id).replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

export function toggleExpandedCardId(
  current: ReadonlySet<string>,
  cardId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(cardId)) next.delete(cardId);
  else next.add(cardId);
  return next;
}

export function handleLibraryCardTextToggle(
  event: Pick<React.MouseEvent<HTMLButtonElement>, "preventDefault" | "stopPropagation">,
  onToggle: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  onToggle();
}

export function LibraryCardText({
  contentId,
  text,
  expanded,
  onToggle,
  className,
}: {
  contentId: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full min-w-0 flex-1 flex-col items-start", className)}>
      <p
        id={contentId}
        className={cn(
          "w-full flex-1 text-[14px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-text",
          !expanded && "line-clamp-4",
        )}
      >
        {text}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={(event) => handleLibraryCardTextToggle(event, onToggle)}
        className="-ml-3 mt-1"
      >
        {expanded ? "Свернуть" : "Развернуть"}
      </Button>
    </div>
  );
}
