import type { Context, Tool } from "@oh-my-pi/pi-ai";

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | { type: string; text?: string; image_url?: string | { url: string } }[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
export type ChatTool = { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } };

const prefix = "opencode_";
export const toCursorName = (name: string): string => `${prefix}${name}`;
export const fromCursorName = (name: string): string => name.startsWith(prefix) ? name.slice(prefix.length) : name;

/**
 * OpenCode tools that must not be advertised to Cursor.
 *
 * Cursor holds its turn open and answers each tool call with a handoff that only
 * resolves on OpenCode's *next* request, so a tool that invites multi-step
 * orchestration inside one turn deadlocks: the model keeps scripting instead of
 * releasing the turn, OpenCode never commits the assistant message, and the
 * results never come back. Code Mode (`execute`) and nested agents (`subagent`)
 * are exactly that shape.
 */
const hiddenTools = new Set(
  (process.env.CURSOR_BRIDGE_HIDDEN_TOOLS ?? "execute,subagent").split(",").map((name) => name.trim()).filter(Boolean),
);
export const isAdvertisedTool = (name: string): boolean => !hiddenTools.has(name);

/**
 * Cursor's own file/shell tools are part of the server-side tool set and cannot be
 * removed from the request, but the bridge cannot execute them. Without an explicit
 * routing note the model burns turns retrying them, then retrying equivalents, and
 * sometimes goes looking for the data on the web. The directive also states the
 * turn contract: results for a tool call arrive on the next request, so a model that
 * keeps calling tools in the same turn is waiting for something that cannot come.
 */
const toolDirective = [
  "Tool routing for this client:",
  "- Cursor's native file, shell, and edit tools are NOT available. Never call them.",
  "- Instead use the opencode_* tools: opencode_read, opencode_write, opencode_edit, opencode_shell, opencode_grep, opencode_glob.",
  "- Tool results arrive on the NEXT turn. Request the tools you need and end your turn; never retry a call that was already handed off.",
].join("\n");

function text(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function userContent(content: ChatMessage["content"]): string | ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] {
  if (typeof content === "string" || content == null) return content ?? "";
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text ?? "" };
    if (part.type !== "image_url") throw new Error(`Unsupported Cursor input: ${part.type}`);
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const match = url?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) throw new Error("Cursor images must be base64 data URLs");
    return { type: "image" as const, mimeType: match[1], data: match[2] };
  });
}

export function contextFromChat(messages: ChatMessage[], tools: ChatTool[] = []): Context {
  const systemPrompt = [...messages.filter((m) => m.role === "system").map((m) => text(m.content)), toolDirective];
  const history: Context["messages"] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    const timestamp = Date.now();
    if (message.role === "system") continue;
    if (message.role === "user" || message.role === "developer") {
      history.push({ role: message.role, content: userContent(message.content), timestamp });
    } else if (message.role === "tool") {
      history.push({ role: "toolResult", toolCallId: message.tool_call_id ?? "", toolName: callNames.get(message.tool_call_id ?? "") ?? toCursorName(message.name ?? "tool"), content: [{ type: "text", text: text(message.content) }], isError: false, timestamp });
    } else {
      for (const call of message.tool_calls ?? []) callNames.set(call.id, toCursorName(call.function.name));
      history.push({
        role: "assistant", api: "cursor-agent", provider: "cursor", model: "cursor",
        content: [
          ...(text(message.content) ? [{ type: "text" as const, text: text(message.content) }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            type: "toolCall" as const, id: call.id, name: toCursorName(call.function.name),
            arguments: parseArguments(call.function.arguments),
          })),
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: message.tool_calls?.length ? "toolUse" : "stop", timestamp,
      });
    }
  }
  const cursorTools: Tool[] = tools
    .filter((t) => t.type === "function" && isAdvertisedTool(t.function.name))
    .map((t) => ({
      name: toCursorName(t.function.name), description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    }));
  return { systemPrompt, messages: history, tools: cursorTools };
}

function parseArguments(raw: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
