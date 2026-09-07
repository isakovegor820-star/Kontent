// Shared immutable role policy for web and Node workers.
export const PROJECT_ROLES = Object.freeze(["owner", "author", "approver", "publisher"]);

export const PROJECT_PERMISSIONS = Object.freeze([
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
]);
const ROLE_PERMISSIONS = {
  owner: new Set(PROJECT_PERMISSIONS),
  author: new Set([
    "project.read",
    "content.create",
    "content.edit",
    "content.submit",
  ]),
  approver: new Set([
    "project.read",
    "content.create",
    "content.edit",
    "content.submit",
    "content.review",
    "content.approve",
    "audience.reply.send",
  ]),
  publisher: new Set([
    "project.read",
    "content.publish",
    "audience.reply.send",
  ]),
};


export function roleAllows(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) === true;
}
