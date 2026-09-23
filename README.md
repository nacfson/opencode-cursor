# opencode-cursor

Connect [OpenCode](https://opencode.ai) to your Cursor account through
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s Cursor transport — the same
browser-login + HTTP/2 agent connection oh-my-pi itself uses, not a Cursor SDK
proxy and not an API-key passthrough.

## How it works

```
OpenCode ──OpenAI-compatible HTTP──▶ local bridge (127.0.0.1:8091)
                                        └── @oh-my-pi/pi-ai `streamCursor`
                                              └── HTTP/2 protobuf agent protocol
                                                    └── api2.cursor.sh
```

- **Model discovery** uses Cursor's `GetUsableModels` RPC, so the model list is
  whatever your account can actually use.
- **Inference** streams through Cursor's `agent.v1.AgentService/Run` RPC with
  the same request framing, heartbeat, and blob exchange oh-my-pi uses.
- **Credentials** come from, in order: `CURSOR_ACCESS_TOKEN`, your existing
  oh-my-pi credential store (`~/.omp/agent/agent.db`), or this package's own
  browser login (PKCE + polling, tokens refreshed automatically).
- **Tool calls** stay inside OpenCode. OpenCode's tools are advertised to Cursor
  as `opencode_*`; when Cursor calls one, the bridge surfaces it to OpenCode as
  a normal tool call, OpenCode executes it under its own permission rules, and
  the result is returned to the model. Cursor-native file/shell frames are *not*
  executed by the bridge.
- **Conversations are stateless**: each request rebuilds the conversation from
  the full transcript OpenCode sends, matching normal OpenAI-compatible clients.

## Requirements

- [Bun](https://bun.sh) (the bridge and plugin run on it)
- OpenCode V2
- A Cursor account

## Setup

```bash
cd ~/tools/opencode-cursor
bun install
```

Register the plugin in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["/Users/you/tools/opencode-cursor"]
}
```

The plugin starts the bridge automatically. If you are not already signed in
through oh-my-pi, connect your Cursor account once:

```bash
bun run login      # opens cursor.com login in your browser
```

Then pick a model:

```bash
opencode models | grep '^cursor/'
opencode run --model cursor/composer-2.5 "hello"
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_BRIDGE_PORT` | `8091` | Bridge port. The plugin passes it to the child process. |
| `CURSOR_ACCESS_TOKEN` | — | Cursor access token; overrides all stored credentials. |
| `BUN_BIN` | `bun` | Executable used to spawn the bridge. |
| `CURSOR_BRIDGE_HIDDEN_TOOLS` | `execute,subagent` | OpenCode tools withheld from Cursor. Both invite multi-step work inside one turn, which cannot resolve through the handoff turn boundary. |
| `CURSOR_BRIDGE_QUIET_MS` | `6000` | After a forwarded tool call, how long the turn may sit silent before the bridge ends it and hands control back to OpenCode. |
| `CURSOR_BRIDGE_TURN_DEADLINE_MS` | `45000` | Idle bound for a turn that has not requested any tool yet. |

### Debug tracing

Create `~/.config/opencode-cursor/debug`, or set `CURSOR_BRIDGE_DEBUG=/path/to/log`, to
append JSONL request/tool-call/cutoff traces. The marker file also works for a bridge the
plugin spawned, whose environment you do not control.

## Why turns end early

Cursor keeps a turn open across tool calls, but OpenCode only executes tools after the
assistant message ends. With `externalToolExecutor` the bridge answers each call with a
"handed off, result next request" note, so a model that keeps calling tools inside one turn
is waiting for data that cannot arrive. Left alone it retries for minutes, including
Cursor-native tools the bridge rejects and cannot observe. The bridge therefore ends the
message when it goes quiet after a tool call, capped at 24 calls and 3 repeats of the same
call. OpenCode then runs the tools and the next request carries the results.

## Running the bridge by hand

Useful for debugging; the plugin reuses a bridge that is already listening.

```bash
bun run serve
curl -s localhost:8091/v1/models                      # model inventory
curl -s localhost:8091/health                         # liveness
curl -N localhost:8091/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"composer-2.5","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Development

```bash
bun run check   # typecheck
bun test        # adapter tests
```

### Layout

| Path | Role |
| --- | --- |
| `src/plugin.ts` | OpenCode plugin: starts the bridge, registers `cursor` + models, refreshes inventory. |
| `src/server.ts` | OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints. |
| `src/adapter.ts` | OpenCode chat messages/tools ⇄ oh-my-pi `Context`. |
| `src/auth.ts` | Credential resolution, PKCE browser login, token refresh. |
| `src/cli.ts` | `login` and `serve` commands. |

## Limitations

- A tool-using task costs one extra model turn: Cursor requests the tools, the bridge ends
  the message, OpenCode executes them, and the next request carries the results. Simple
  text turns are unaffected.
- Cursor's native file/shell tools cannot be removed from the request, so they are rejected
  and the model is directed to the `opencode_*` equivalents. A short-lived redundant call
  before it follows the directive is normal.
- `usage.prompt_tokens` is reported as `0`; Cursor's stream only reports output tokens.
- Cost is not reported to OpenCode (`cost: []`), since Cursor bills by plan.
- Images are accepted as base64 data URLs; remote image URLs are rejected.
