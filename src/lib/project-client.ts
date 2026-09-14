export type ClientProjectRole = "owner" | "author" | "approver" | "publisher";

export type ClientProject = {
  id: number;
  name: string;
  timezone: string;
  role: ClientProjectRole;
  version: number;
  personal: boolean;
  selected: boolean;
  createdAt: string;
};

const ROLES: readonly ClientProjectRole[] = ["owner", "author", "approver", "publisher"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClientProject(value: unknown): ClientProject | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const version = Number(value.version);
  if (
    !Number.isSafeInteger(id) || id <= 0
    || typeof value.name !== "string" || !value.name.trim()
    || typeof value.timezone !== "string" || !value.timezone.trim()
    || !ROLES.includes(value.role as ClientProjectRole)
    || !Number.isSafeInteger(version) || version <= 0
  ) return null;
  return {
    id,
    name: value.name.trim(),
    timezone: value.timezone.trim(),
    role: value.role as ClientProjectRole,
    version,
    personal: value.personal === true,
    selected: value.selected === true,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  };
}

export function parseProjectsResponse(value: unknown): ClientProject[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.projects)) return null;
  const projects = value.projects.map(parseClientProject);
  return projects.every((project): project is ClientProject => project !== null) ? projects : null;
}
