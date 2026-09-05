import type { NextRequest } from "next/server";
import { ProjectAccessError } from "./project-permissions";

/** Native images, video and downloads cannot attach the tab's fetch header. */
export function nativeRequestProjectId(req: NextRequest): number {
  const values = req.nextUrl.searchParams.getAll("projectId");
  const header = req.headers.get("x-aurora-project-id");
  const valid = (value: string | null): number | null => {
    if (value === null || !/^[1-9]\d*$/u.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
  };
  const queryId = values.length === 1 ? valid(values[0]) : null;
  const headerId = valid(header);
  if (values.length > 1 || (values.length === 1 && queryId === null)
      || (header !== null && headerId === null)
      || (queryId !== null && headerId !== null && queryId !== headerId)
      || (queryId === null && headerId === null)) {
    throw new ProjectAccessError("invalid_project_selector");
  }
  return (queryId ?? headerId)!;
}
