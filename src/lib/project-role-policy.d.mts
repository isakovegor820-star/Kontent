export const PROJECT_ROLES: readonly ["owner", "author", "approver", "publisher"];
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_PERMISSIONS: readonly [
  "project.read",
  "project.manage",
  "members.manage",
  "content.create",
  "content.edit",
  "content.submit",
  "content.review",
  "content.approve",
  "content.publish",
  "audience.reply.send",
  "audit.read",
];
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];


export function roleAllows(role: ProjectRole, permission: ProjectPermission): boolean;
