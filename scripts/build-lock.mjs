import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function ownerAlive(pid, signalProcess = globalThis.process.kill.bind(globalThis.process)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

export function buildLockDirectory(cwd = globalThis.process.cwd(), temporaryDirectory = tmpdir()) {
  const workspaceId = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 20);
  return join(temporaryDirectory, `aurora-build-${workspaceId}.lock`);
}

export function acquireBuildLock({
  cwd = globalThis.process.cwd(),
  temporaryDirectory = tmpdir(),
  pid = globalThis.process.pid,
  signalProcess,
  token: requestedToken,
} = {}) {
  const lockDirectory = buildLockDirectory(cwd, temporaryDirectory);
  const token = String(requestedToken || randomUUID());
  try {
    mkdirSync(lockDirectory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readOwner(lockDirectory);
    if (!owner) throw new Error("another Aurora production build is acquiring the build lock");
    if (owner.token === token) return () => {};
    if (ownerAlive(Number(owner?.pid), signalProcess)) {
      throw new Error(`another Aurora production build is running (pid ${owner.pid})`);
    }
    rmSync(lockDirectory, { recursive: true, force: true });
    try {
      mkdirSync(lockDirectory);
    } catch (retryError) {
      if (retryError?.code === "EEXIST") {
        throw new Error("another Aurora production build acquired the build lock");
      }
      throw retryError;
    }
  }
  writeFileSync(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({ pid, token, acquiredAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readOwner(lockDirectory)?.token !== token) return;
    rmSync(lockDirectory, { recursive: true, force: true });
  };
}
