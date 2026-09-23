import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { accessToken } from "./auth";
import { contextFromChat, fromCursorName, type ChatMessage, type ChatTool } from "./adapter";

type ChatRequest = { model: string; messages: ChatMessage[]; tools?: ChatTool[]; stream?: boolean };
const host = "127.0.0.1";
const port = Number(process.env.CURSOR_BRIDGE_PORT ?? "8091");
const debugLog =
  process.env.CURSOR_BRIDGE_DEBUG ??
  (existsSync(join(homedir(), ".config", "opencode-cursor", "debug"))
    ? join(homedir(), ".config", "opencode-cursor", "debug.log")
    : undefined);
const trace = (event: string, data?: unknown): void => {
  if (!debugLog) return;
  void import("node:fs/promises").then((fs) =>
    fs.appendFile(debugLog, `${JSON.stringify({ ts: Date.now(), event, data })}\n`).catch(() => {}),
  );
};
let models = new Map<string, Model<"cursor-agent">>();
let updatedAt = 0;
let loading: Promise<void> | undefined;

export async function refreshModels(): Promise<void> {
  loading ??= (async () => {
    const token = await accessToken();
    const discovered = await fetchCursorUsableModels({ apiKey: token });
    if (discovered === null) {
      if (models.size === 0) throw new Error("Cursor model discovery failed");
      return;
    }
    models = new Map(discovered.map((spec: ModelSpec<"cursor-agent">) => [spec.id, buildModel(spec)]));
    updatedAt = Date.now();
  })().finally(() => { loading = undefined; });
  return loading;
}

async function modelFor(id: string): Promise<Model<"cursor-agent">> {
  if (!models.size || Date.now() - updatedAt > 5 * 60_000) await refreshModels();
  const model = models.get(id);
  if (model) return model;
  // Bundled metadata is only a fallback for a temporarily unavailable catalog.
  if (!updatedAt) return getBundledModels("cursor").find((m) => m.id === id) as Model<"cursor-agent">;
  throw new Error(`Model ${id} is not available on this Cursor account`);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<ChatRequest> {
  let data = "";
  for await (const part of request) {
    data += part.toString();
    if (data.length > 8_000_000) throw new Error("Request is too large");
  }
  const value = JSON.parse(data) as ChatRequest;
  if (!value || typeof value.model !== "string" || !Array.isArray(value.messages)) throw new Error("Invalid chat request");
  return value;
}

export async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && request.url === "/v1/models") {
      await refreshModels();
      return json(response, 200, { object: "list", data: [...models.values()].map((m) => ({ id: m.id, object: "model", name: m.name, context_window: m.contextWindow, max_tokens: m.maxTokens, input: m.input })) });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, { error: { message: "Not found" } });
    const input = await body(request);
    trace("request", {
      model: input.model,
      stream: input.stream === true,
      messages: input.messages.map((message) => message.role),
      tools: (input.tools ?? []).map((tool) => tool.function.name),
      last: input.messages.at(-1)?.role,
    });
    const model = await modelFor(input.model);
    if (!model) throw new Error(`Unknown Cursor model: ${input.model}`);
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    if (input.stream) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const text: string[] = [];
    const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (input.stream) send({ role: "assistant", content: "" });
    // No conversationId: each request is rebuilt from the full transcript, matching
    // stateless OpenAI-compatible semantics and avoiding stale Cursor-side state.
    const stream = streamCursor(model, contextFromChat(input.messages, input.tools), {
      apiKey: await accessToken(), signal: controller.signal,
      externalToolExecutor: true,
    });
    // Cursor keeps its turn open across tool handoffs, but OpenCode only runs the tools
    // once this message ends. A model that keeps re-requesting work inside one turn
    // learns nothing and loops — including on Cursor-native tools the bridge rejects but
    // cannot observe. So the message ends as soon as the model stops making *visible*
    // progress after forwarding a tool call, with a hard deadline as a backstop.
    const quietMs = Number(process.env.CURSOR_BRIDGE_QUIET_MS ?? 6_000);
    const idleMs = Number(process.env.CURSOR_BRIDGE_TURN_DEADLINE_MS ?? 45_000);
    let cutoff: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stopTimer = (): void => { if (timer) { clearTimeout(timer); timer = undefined; } };
    const armTimer = (): void => {
      stopTimer();
      const window = toolCalls.length ? quietMs : idleMs;
      timer = setTimeout(() => {
        cutoff = toolCalls.length ? "turn quiet after tool call" : "turn idle";
        controller.abort();
      }, window);
    };
    const seen = new Set<string>();
    let duplicates = 0;
    armTimer();
    try {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          text.push(event.delta);
          if (input.stream) send({ content: event.delta });
          armTimer();
        } else if (event.type === "thinking_delta") {
          armTimer();
        } else if (event.type === "toolcall_end") {
          trace("toolcall", { name: event.toolCall.name, id: event.toolCall.id, args: event.toolCall.arguments });
          if (!event.toolCall.name.startsWith("opencode_")) continue;
          const key = `${event.toolCall.name}:${JSON.stringify(event.toolCall.arguments)}`;
          if (seen.has(key)) {
            duplicates += 1;
            trace("toolcall-duplicate", { name: event.toolCall.name, duplicates });
            if (duplicates >= 3) { cutoff = "repeated tool calls"; break; }
            continue;
          }
          seen.add(key);
          const call = { id: event.toolCall.id, type: "function" as const, function: { name: fromCursorName(event.toolCall.name), arguments: JSON.stringify(event.toolCall.arguments) } };
          const index = toolCalls.push(call) - 1;
          if (input.stream) send({ tool_calls: [{ index, ...call }] });
          armTimer();
          if (toolCalls.length >= 24) { cutoff = "tool-call cap"; break; }
        } else if (event.type === "done") {
          stopTimer();
          usage = { prompt_tokens: event.message.usage.input, completion_tokens: event.message.usage.output, total_tokens: event.message.usage.totalTokens };
        } else if (event.type === "error") {
          if (cutoff) break;
          throw new Error(event.error.errorMessage ?? "Cursor agent request failed");
        }
      }
    } catch (error) {
      if (!cutoff) throw error;
    } finally {
      stopTimer();
    }
    if (cutoff) {
      trace("turn-cutoff", { reason: cutoff, forwarded: toolCalls.length });
      controller.abort();
    }
    const finish_reason = toolCalls.length ? "tool_calls" : "stop";
    if (input.stream) {
      send({}, finish_reason);
      response.end("data: [DONE]\n\n");
    } else {
      json(response, 200, { id, object: "chat.completion", created, model: model.id, choices: [{ index: 0, message: { role: "assistant", content: text.join(""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason }], usage });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (response.headersSent) {
      response.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else json(response, 400, { error: { message } });
  }
}

export function serve() {
  const server = createServer((req, res) => { void handle(req, res); });
  server.listen(port, host, () => console.log(`opencode-cursor bridge listening on http://${host}:${port}`));
  return server;
}
