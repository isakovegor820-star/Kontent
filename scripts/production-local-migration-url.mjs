import { pathToFileURL } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEFAULT_SOCKET_DIRECTORY = "/var/run/postgresql";

export function productionLocalPeerMigrationUrl(
  runtimeDatabaseUrl,
  socketDirectory = DEFAULT_SOCKET_DIRECTORY,
) {
  let target;
  try {
    target = new URL(String(runtimeDatabaseUrl || ""));
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(target.protocol)) {
    throw new Error("DATABASE_URL is not a PostgreSQL URL");
  }

  const socketHost = target.searchParams.get("host");
  const targetsLocalSocket = socketHost?.startsWith("/") === true;
  if (!targetsLocalSocket && !LOCAL_HOSTS.has(target.hostname)) {
    throw new Error("local peer migrations require a loopback or Unix-socket DATABASE_URL");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ""));
  if (!databaseName || databaseName.includes("\0")) {
    throw new Error("DATABASE_URL must name a database");
  }
  if (!socketDirectory.startsWith("/")) {
    throw new Error("PostgreSQL socket directory must be absolute");
  }

  const port = target.port || "5432";
  return `postgresql:///${encodeURIComponent(databaseName)}?host=${encodeURIComponent(socketDirectory)}&port=${port}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(productionLocalPeerMigrationUrl(process.env.DATABASE_URL));
  } catch (error) {
    console.error(
      `[deploy] local peer migration target rejected: ${error instanceof Error ? error.message : "invalid target"}`,
    );
    process.exitCode = 1;
  }
}
