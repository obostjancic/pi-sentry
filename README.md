# Sentry Extension for pi

[Sentry](https://sentry.io) observability for [pi](https://github.com/badlogic/pi-mono) coding agent sessions — distributed tracing and error capture.

Monitoring is safe by default: traces are on, but tool inputs and outputs are not captured unless you opt in.

## What It Does

Every agent session becomes a Sentry trace. Tool calls, LLM requests, token usage, and errors are captured as spans with full [AI Agent Monitoring](https://docs.sentry.io/product/ai-monitoring/) attributes.

### Trace Structure

```
gen_ai.invoke_agent (per user interaction)
├── gen_ai.execute_tool (per tool call — bash, read, edit, etc.)
└── gen_ai.chat (per LLM request — model, tokens, latency)
```

Each user message starts a new trace. Tool inputs/outputs and LLM responses are captured only when you opt in with `recordInputs` and `recordOutputs`.

### Attributes

Spans follow the canonical [Sentry `gen_ai.*` conventions](https://getsentry.github.io/sentry-conventions/attributes/gen_ai/) — no deprecated keys are emitted. Notable mappings:

| Data | Attribute |
|---|---|
| Provider | `gen_ai.provider.name` |
| Input messages (opt-in) | `gen_ai.input.messages` (`{role, parts}` shape) |
| Output messages (opt-in) | `gen_ai.output.messages` (text + reasoning + tool calls) |
| Tool arguments (opt-in) | `gen_ai.tool.call.arguments` |
| Tool result (opt-in) | `gen_ai.tool.call.result` |
| Cached input tokens | `gen_ai.usage.cache_read.input_tokens` |
| Cache-write tokens | `gen_ai.usage.cache_creation.input_tokens` |
| Finish reason | `gen_ai.response.finish_reasons` |

pi-specific metadata (session id, project name, turn index, tool call id) is namespaced under `pi.*`.

## Install

**Global** (all projects):
```bash
pi install npm:pi-sentry
```

**Project-local** (shared with teammates):
```bash
pi install npm:pi-sentry -l
```

Run `/reload` in pi to activate without restarting.

## Configure Monitoring

Create `.pi/sentry.json` (or `.jsonc`):

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456"
}
```

That's it. Traces flow immediately. Without a DSN the extension stays inactive. If you want request text or tool payloads in Sentry, opt in explicitly:

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456",
  "recordInputs": true,
  "recordOutputs": true
}
```

By default, `recordInputs` and `recordOutputs` are `false`, so the extension captures structure and timing without storing conversation or tool content.

### Config File Locations (first match wins)

1. `$PI_SENTRY_CONFIG` env var (explicit path)
2. `<project>/.pi/sentry.json[c]`
3. `~/.pi/agent/sentry.json[c]`

### Environment Variable Overrides

| Variable | Description |
|---|---|
| `PI_SENTRY_DSN` / `SENTRY_DSN` | Sentry DSN |
| `PI_SENTRY_TRACES_SAMPLE_RATE` | Sample rate (0–1) |
| `PI_SENTRY_RECORD_INPUTS` | Capture tool inputs (true/false, default `false`) |
| `PI_SENTRY_RECORD_OUTPUTS` | Capture tool outputs (true/false, default `false`) |
| `PI_SENTRY_TAGS` | Custom tags (`key:value,key:value`) |
| `SENTRY_ENVIRONMENT` | Environment name |
| `SENTRY_RELEASE` | Release version |

### Full Config Reference

```json
{
  "dsn": "https://...",
  "tracesSampleRate": 1,
  "environment": "production",
  "release": "1.0.0",
  "debug": false,
  "agentName": "my-agent",
  "projectName": "my-project",
  "recordInputs": false,
  "recordOutputs": false,
  "maxAttributeLength": 12000,
  "includeMessageUsageSpans": true,
  "includeSessionEvents": true,
  "tags": {
    "team": "platform"
  }
}
```

To capture content when you need it, enable `recordInputs` and `recordOutputs` in config or via the matching environment variables.

## Event Mapping

| pi event | Sentry span / action |
|---|---|
| `input` | End current trace, start a new one for the new interaction |
| `turn_start` | Track turn index |
| `model_select` | Update model/provider on active spans |
| `tool_execution_start` | Start `gen_ai.execute_tool` child span |
| `tool_execution_end` | End tool span with result/error status |
| `message_start` (assistant) | Start `gen_ai.chat` span (measures LLM latency) |
| `message_end` (assistant) | End chat span, attach token usage and content |
| `turn_end` | Flush completed trace to Sentry |
| `session_shutdown` | Close all open spans, flush, shut down client |
| `extension_error` | Capture exception from any extension handler crash |

## Development

```bash
git clone https://github.com/HazAT/pi-sentry && cd pi-sentry
npm install

# Run without installing
pi -e ./pi-extension/index.ts

# Checks (all must pass before commit)
vp check       # format + lint + typecheck
vp test        # run tests

# Optional maintainer-only patch helper
npm run patch:apply
```

## License

MIT
