import { describe, expect, test } from "bun:test";
import { contextFromChat } from "../src/adapter";

describe("Cursor/OpenCode message adapter", () => {
  test("keeps assistant tool calls paired with OpenCode tool results", () => {
    const context = contextFromChat([
      { role: "system", content: "Be concise" },
      { role: "user", content: "Read the file" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
      { role: "user", content: "Summarize it" },
    ], [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }]);
    expect(context.systemPrompt?.[0]).toBe("Be concise");
    expect(context.systemPrompt?.join("\n")).toContain("Tool routing for this client");
    expect(context.tools?.[0]?.name).toBe("opencode_read");
    expect(context.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", toolName: "opencode_read" });
    expect(context.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "opencode_read", arguments: { path: "a.txt" } }] });
  });

  test("keeps image attachments rather than dropping them", () => {
    const context = contextFromChat([{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }] }]);
    expect(context.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", mimeType: "image/png", data: "YWJj" }] });
    expect(() => contextFromChat([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }])).toThrow("base64 data URLs");
  });

  test("routes native tools away and states the turn contract", () => {
    const context = contextFromChat([{ role: "system", content: "Be concise" }, { role: "user", content: "hi" }], [
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "execute" } },
      { type: "function", function: { name: "subagent" } },
    ]);
    expect(context.systemPrompt?.[0]).toBe("Be concise");
    expect(context.systemPrompt?.join("\n")).toContain("Tool results arrive on the NEXT turn");
    expect(context.tools?.map((tool) => tool.name)).toEqual(["opencode_read"]);
  });
});
