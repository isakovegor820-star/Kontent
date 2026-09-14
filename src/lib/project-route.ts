import { NextRequest, NextResponse } from "next/server";
import { ProjectAccessError } from "./project-permissions";
import { hasTrustedMutationOrigin } from "./request-origin";
import { getSessionUser } from "./session";
import { runWithProjectRequest, type ProjectRequestContext } from "./project-request-context";

export const PROJECT_HEADER = "x-aurora-project-id";
export function parseRequestProjectId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** Every project route runs here, including requests excluded by the Next proxy matcher. */
export function withProjectRoute<Args extends unknown[]>(
  handler: (request: NextRequest, ...args: Args) => Promise<Response>,
  options: { objectRead?: boolean; projectInPath?: boolean } = {},
) {
  return async (request: NextRequest, ...args: Args): Promise<Response> => {
    const header = request.headers.get(PROJECT_HEADER);
    const query = request.nextUrl.searchParams.getAll("projectId");
    const pathId = options.projectInPath ? request.nextUrl.pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/u)?.[1] : null;
    const selectors = [header, ...query, pathId].filter((value): value is string => value != null);
    const projectId = parseRequestProjectId(selectors[0] ?? null);
    if (selectors.some((value) => !parseRequestProjectId(value) || value !== selectors[0])) {
      return NextResponse.json({ ok: false, error: "invalid_project_selector" }, { status: 400 });
    }
    if (!projectId && !options.objectRead) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !hasTrustedMutationOrigin(request)) {
      return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
    }

      const user = await getSessionUser(request);
      return NextResponse.json({ ok: false, error: user ? "project_context_required" : "unauthorized" }, { status: user ? 428 : 401 });
    }
    const context: ProjectRequestContext = { projectId, mismatch: false };
    return runWithProjectRequest(context, async () => {
      let response: Response;
      try { response = await handler(request, ...args); }
      catch (error) {
        if (!(error instanceof ProjectAccessError)) throw error;
        response = NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
      }
      if (context.mismatch) return NextResponse.json({ ok: false, error: "project_context_mismatch" }, { status: 409 });
      if (context.denied && response.status !== 403) response = NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
      if (context.projectId != null) response.headers.set(PROJECT_HEADER, String(context.projectId));
      // Responses are private to the authorized project, even for identical account cookies.
      response.headers.set("cache-control", "private, no-store");
      response.headers.append("vary", PROJECT_HEADER);
      return response;
    });
  };
}
