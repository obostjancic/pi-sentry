# Sentry Extension for pi

[Sentry](https://sentry.io) observability for [pi](https://github.com/badlogic/pi-mono) coding agent sessions — distributed tracing and error capture.

Full capture is on by default: traces, tool inputs, and tool outputs are all recorded. Set `recordInputs` / `recordOutputs` to `false` in config or env if you want structure-only tracing.

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
pi install git:git@github.com:obostjancic/pi-sentry.git
```

**Project-local** (shared with teammates):
```bash
pi install git:git@github.com:obostjancic/pi-sentry.git -l
```

Or use the npm package once published:
```bash
pi install npm:pi-sentry
```

Run `/reload` in pi to activate without restarting.

## Configure Monitoring

Create `.pi/sentry.json` (or `.jsonc`):

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456"
}
```

That's it. Traces flow immediately with full input/output capture. Without a DSN the extension stays inactive. To capture structure and timing only (no conversation or tool content), disable capture explicitly:

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456",
  "recordInputs": false,
  "recordOutputs": false
}
```

### Config File Locations (first match wins)

1. `$PI_SENTRY_CONFIG` env var (explicit path)
2. `<project>/.pi/sentry.json[c]`
3. `~/.pi/agent/sentry.json[c]`

### Environment Variable Overrides

| Variable | Description |
|---|---|
| `PI_SENTRY_DSN` / `SENTRY_DSN` | Sentry DSN |
| `PI_SENTRY_TRACES_SAMPLE_RATE` | Sample rate (0–1) |
| `PI_SENTRY_RECORD_INPUTS` | Capture tool inputs (true/false, default `true`) |
| `PI_SENTRY_RECORD_OUTPUTS` | Capture tool outputs (true/false, default `true`) |
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
  "recordInputs": true,
  "recordOutputs": true,
  "maxAttributeLength": 12000,
  "includeMessageUsageSpans": true,
  "includeSessionEvents": true,
  "tags": {
    "team": "platform"
  }
}
```

To disable content capture, set `recordInputs` and `recordOutputs` to `false` in config or via the matching environment variables.

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
git clone https://github.com/obostjancic/pi-sentry && cd pi-sentry
npm install

# Run without installing
PI_CODING_AGENT_DIR="$(mktemp -d)" PI_SENTRY_DSN="https://exampleKey@o0.ingest.sentry.io/0" pi -e .

# Checks (all must pass before commit)
npm run check   # format + lint + typecheck
npm test        # run tests

# Optional maintainer-only: apply extension_error patch to local SDK for testing
npm run patch:apply
```

Note: this package targets `@earendil-works/pi-coding-agent@^0.79.x`. The `extension_error` event for sibling-extension error capture is not upstream; `npm run patch:apply` adds a local patch to test that optional path.

## License

MIT
