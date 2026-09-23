import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Model, Plugin, Provider } from "@opencode/plugin";

const port = Number(process.env.CURSOR_BRIDGE_PORT ?? "8091");
const baseURL = `http://127.0.0.1:${port}/v1`;
const root = fileURLToPath(new URL("..", import.meta.url));

type RemoteModel = { id: string; name: string; context_window: number; max_tokens: number; input: string[] };

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function inventory(): Promise<RemoteModel[]> {
  const response = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error((await response.text()).slice(0, 500));
  return ((await response.json()) as { data: RemoteModel[] }).data;
}

/** Spawn the bridge if nothing is listening. Returns the owned child, or undefined when one already ran. */
async function boot(): Promise<ChildProcess | undefined> {
  if (await healthy()) return undefined;
  const child = spawn(process.env.BUN_BIN ?? "bun", ["src/cli.ts", "serve"], { cwd: root, env: process.env, stdio: "ignore" });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await healthy()) return child;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error("Cursor bridge failed to start. Run `bun run serve` in the plugin directory for details.");
}

const fingerprint = (models: RemoteModel[]): string => models.map((model) => model.id).sort().join("\n");

function modelOf(providerID: ReturnType<typeof Provider.ID.make>, entry: RemoteModel) {
  return {
    ...Model.Info.default(providerID, Model.ID.make(entry.id)),
    name: entry.name,
    capabilities: {
      tools: true,
      input: entry.input.includes("image") ? (["text", "image"] as const) : (["text"] as const),
      output: ["text"] as const,
    },
    limit: { context: entry.context_window || 200_000, output: entry.max_tokens || 64_000 },
  };
}

export default Plugin.define({
  id: "opencode-cursor",
  async setup(ctx) {
    const providerID = Provider.ID.make("cursor");
    const info = {
      ...Provider.Info.empty(providerID),
      name: "Cursor (oh-my-pi)",
      activation: "enabled" as const,
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL },
    };
    // Owned child process. Stays undefined when an externally started bridge is reused;
    // an unowned bridge is never killed on unload.
    let child: ChildProcess | undefined;
    let remote: RemoteModel[] = [];
    let refreshing = false;

    const ensureBridge = async (): Promise<void> => {
      if (await healthy()) return;
      child = await boot();
    };

    child = await boot();
    try {
      remote = await inventory();
    } catch (error) {
      console.warn("opencode-cursor: model inventory unavailable; retrying in the background.", error);
    }

    await ctx.provider.transform((editor) => {
      const models = remote.map((entry) => modelOf(providerID, entry));
      if (editor.get("cursor")) {
        editor.update("cursor", (draft) => Object.assign(draft, info));
        editor.models.set("cursor", models);
      } else {
        editor.add({ info, models });
      }
    });

    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        await ensureBridge();
        const next = await inventory();
        if (fingerprint(next) === fingerprint(remote)) return;
        remote = next;
        await ctx.provider.transform((editor) => {
          if (editor.get("cursor")) editor.models.set("cursor", next.map((entry) => modelOf(providerID, entry)));
        });
        await ctx.provider.reload();
      } catch (error) {
        console.warn("opencode-cursor: refresh failed.", error);
      } finally {
        refreshing = false;
      }
    };

    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      clearInterval(timer);
      if (child && child.exitCode === null) child.kill();
    };
  },
});
