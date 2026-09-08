/** A response from the explicitly selected project in a client service test. */
export class ProjectResponse extends Response {
  constructor(projectId: number, body?: BodyInit | null, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.set("x-aurora-project-id", String(projectId));
    super(body, { ...init, headers });
  }
}
export function projectJson(projectId: number, body: unknown, init?: ResponseInit) {
  return new ProjectResponse(projectId, JSON.stringify(body), init);
}
