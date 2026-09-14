/** Shared HTTP representation; version is the membership version, not a selection epoch. */
export type ProjectDto = {
  id: number;
  name: string;
  timezone: string;
  role: "owner" | "author" | "approver" | "publisher";
  version: number;
  personal: boolean;
  selected: boolean;
  createdAt: string;
};

export function selectedProjectDto(context: {
  projectId: number;
  name: string;
  timezone: string;
  role: ProjectDto["role"];
  version: number;
  personal: boolean;
  createdAt?: string;
}): ProjectDto {
  return {
    id: context.projectId,
    name: context.name,
    timezone: context.timezone,
    role: context.role,
    version: context.version,
    personal: context.personal,
    selected: true,
    createdAt: context.createdAt ?? "",
  };
}
