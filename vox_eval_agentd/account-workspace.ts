import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const privateDirectory = (file: string) => {
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error("Unsafe account workspace");
};
function workspaceBase() {
  const root = path.join(fs.realpathSync(os.tmpdir()), `vox-account-sessions-${process.getuid?.() ?? "local"}`);
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  privateDirectory(root);
  return root;
}
function lockOwner(root: string, create: boolean) {
  const fd = fs.openSync(path.join(root, "owner.lock"), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW |
    (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o600);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error();
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"],
      { stdio: ["ignore", "ignore", "ignore", fd], env: { PATH: process.env.PATH }, timeout: 1000 });
    if (result.status === 0) return fd;
    if (result.status !== 75) throw new Error();
    fs.closeSync(fd); return null;
  } catch { fs.closeSync(fd); throw new Error("Account workspace lock unavailable"); }
}

/** Remove only private, manager-created roots whose lifetime lock has gone away. */
export function sweepAccountWorkspaces() {
  const base = workspaceBase();
  for (const name of fs.readdirSync(base).slice(0, 1024)) {
    if (!/^run-[a-f0-9-]{36}$/.test(name)) continue;
    const root = path.join(base, name);
    let fd: number | null = null;
    try {
      privateDirectory(root);
      if (Date.now() - fs.lstatSync(root).mtimeMs < 60_000) continue;
      fd = lockOwner(root, false);
      if (fd !== null) fs.rmSync(root, { recursive: true, force: true });
    } catch { /* Unknown or unsafe directories are never followed or uploaded. */ }
    finally { if (fd !== null) fs.closeSync(fd); }
  }
}

let sweeping = false;
export function initializeAccountWorkspaces() {
  if (sweeping) return;
  sweepAccountWorkspaces(); sweeping = true;
  setInterval(() => { try { sweepAccountWorkspaces(); } catch { /* Retry on next sweep. */ } }, 60_000).unref();
}

export function createAccountWorkspace() {
  initializeAccountWorkspaces();
  const root = path.join(workspaceBase(), `run-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  let fd: number | null;
  try { fd = lockOwner(root, true); if (fd === null) throw new Error("Account workspace busy"); }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  let closed = false;
  return { root, storageFile: path.join(root, "storage.json"), close() {
    if (closed) return;
    closed = true;
    try { fs.rmSync(root, { recursive: true, force: true }); } finally { fs.closeSync(fd); }
  } };
}
