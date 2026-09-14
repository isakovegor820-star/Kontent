import policies from "./project-route-policies.json";
export const PROJECT_HEADER = "x-aurora-project-id";
const routes = policies.map((route) => ({
  ...route,
  pattern: new RegExp(`^${route.path.split("/").map((part) => part.startsWith("[") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}/?$`, "u"),
}));
export function isProjectHttpRequest(path: string, method: string): boolean {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  // A literal context endpoint such as /projects/current outranks /projects/[projectId].
  const matches = routes.filter((route) => route.method === verb && route.pattern.test(path));
  const exact = matches.find((route) => route.path === path.replace(/\/$/u, ""));
  return (exact ?? matches[0])?.policy === "project";
}
