import { NextRequest } from "next/server";

/** Explicit HTTP project fixture. Boundary tests use plain NextRequest for absent selectors. */
export class ProjectRequest extends NextRequest {
  constructor(projectId: number, input: ConstructorParameters<typeof NextRequest>[0], init?: ConstructorParameters<typeof NextRequest>[1]) {
    const headers = new Headers(init?.headers);
    headers.set("x-aurora-project-id", String(projectId));
    super(input, { ...init, headers });
  }
}
