import { AsyncLocalStorage } from "node:async_hooks";

/** A selector captured at the HTTP boundary, never a cached authorization decision. */
export type ProjectRequestContext = {
  projectId: number | null;
  mismatch: boolean;
  denied?: boolean;
};
const requests = new AsyncLocalStorage<ProjectRequestContext>();
export const getProjectRequestContext = () => requests.getStore();
export const runWithProjectRequest = <T>(context: ProjectRequestContext, task: () => T): T => requests.run(context, task);

export function requestProjectMatches(projectId: number): boolean {
  const context = requests.getStore();
  if (!context) return true; // Non-HTTP services must supply their own explicit scope.
  if (context.projectId == null) context.projectId = projectId; // Object-derived reads.
  if (context.projectId !== projectId) { context.mismatch = true; return false; }
  return true;
}
