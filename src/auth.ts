import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loginCursor, refreshCursorToken } from "@oh-my-pi/pi-ai/registry/oauth/cursor";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

const directory = join(homedir(), ".config", "opencode-cursor");
const file = join(directory, "credentials.json");
type Credentials = { access: string; refresh: string; expires: number };

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `credentials.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export async function login(): Promise<void> {
  const credentials = await loginCursor((url) => {
    console.log(`Sign in to Cursor: ${url}`);
    if (process.platform === "darwin") Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }, () => console.log("Waiting for Cursor browser sign-in…"));
  await saveCredentials(credentials);
  console.log("Cursor connection saved.");
}

let refreshInFlight: Promise<string> | undefined;
export async function accessToken(): Promise<string> {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  try {
    const storage = await AuthStorage.create(join(homedir(), ".omp", "agent", "agent.db"));
    try {
      await storage.reload();
      const token = await storage.getApiKey("cursor");
      if (token) return token;
    } finally { storage.close(); }
  } catch { /* An oh-my-pi install/store is optional; use the plugin's own login below. */ }
  let credentials: Credentials;
  try {
    credentials = JSON.parse(await readFile(file, "utf8")) as Credentials;
  } catch {
    throw new Error("Cursor is not connected. Run `bun run login` or set CURSOR_ACCESS_TOKEN.");
  }
  if (credentials.expires > Date.now()) return credentials.access;
  refreshInFlight ??= (async () => {
    const updated = await refreshCursorToken(credentials.refresh);
    await saveCredentials(updated);
    return updated.access;
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}
