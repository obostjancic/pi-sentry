import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { PluginLogger, ResolvedPluginConfig } from "./config.ts";
import { basename, dirname } from "node:path";

/** Sentry span type — avoids importing Sentry in pure helper code */
export type SentrySpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number }): void;
  spanContext(): { traceId: string };
  end(): void;
};

export function createLogger(): PluginLogger {
  const service = "sentry";

  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    const prefix = `[${service}] ${message}`;
    if (level === "error") {
      console.error(prefix, extra ?? "");
      return;
    }
    if (level === "warn") {
      console.warn(prefix, extra ?? "");
      return;
    }
    if (level === "debug") {
      console.debug(prefix, extra ?? "");
      return;
    }
    console.info(prefix, extra ?? "");
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

export function getProjectName(config: ResolvedPluginConfig, cwd: string): string {
  if (config.projectName && config.projectName.length > 0) {
    return config.projectName;
  }
  const guessed = basename(cwd);
  return guessed.length > 0 ? guessed : "pi-project";
}

/**
 * Detects the subagent name from CLI args when spawned by pi-subagents.
 *
 * pi-subagents writes each agent's system prompt to a temp file named
 * `{agent}.md` inside a `pi-subagent-XXXX/` directory, then passes it
 * as `--append-system-prompt /tmp/pi-subagent-XXXX/worker.md`. The agent
 * name is therefore recoverable from process.argv without any changes to
 * pi-subagents.
 */
export function detectSubagentName(): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--append-system-prompt") continue;
    const promptPath = args[i + 1];
    if (!promptPath) continue;

    const dirName = basename(dirname(promptPath));
    if (!dirName.startsWith("pi-subagent-")) continue;

    const fileName = basename(promptPath);
    const agentName = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

    if (/^[\w.-]+$/.test(agentName) && agentName.length > 0) {
      return agentName;
    }
  }
  return undefined;
}

export function getAgentName(config: ResolvedPluginConfig): string {
  if (config.agentName && config.agentName.length > 0) {
    return config.agentName;
  }
  const subagentName = detectSubagentName();
  if (subagentName) {
    return `pi/${subagentName}`;
  }
  return "pi";
}

export function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

export function attachTokenUsage(
  span: SentrySpan,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  },
): { totalInput: number; totalOutput: number } {
  // gen_ai.usage.input_tokens must be TOTAL input tokens per OTel semantic conventions.
  // Pi's usage.input only contains non-cached tokens (Anthropic's input_tokens field),
  // so we add cache_read + cache_write to get the true total.
  const totalInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const totalOutput = usage.output ?? 0;
  if (totalInput > 0) {
    span.setAttribute("gen_ai.usage.input_tokens", totalInput);
  }
  if (totalOutput > 0) {
    span.setAttribute("gen_ai.usage.output_tokens", totalOutput);
  }
  if (typeof usage.cacheRead === "number") {
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
  }
  if (typeof usage.cacheWrite === "number") {
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", usage.cacheWrite);
  }
  const totalTokens = totalInput + totalOutput;
  if (totalTokens > 0) {
    span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
  }
  return { totalInput, totalOutput };
}

/**
 * Canonical gen_ai message shape per the Sentry Conventions.
 * See https://getsentry.github.io/sentry-conventions/attributes/gen_ai/
 * Each message has a `role` and a list of `parts`; arrays/objects must be
 * JSON-stringified before being set as span attributes.
 */
export type GenAiPart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; result: unknown };

export interface GenAiMessage {
  role: "user" | "assistant" | "tool" | "system";
  parts: GenAiPart[];
  finish_reason?: string;
}

/** Maps pi's StopReason to a gen_ai.response.finish_reasons value. */
export function mapFinishReason(stopReason: string): string {
  return stopReason === "toolUse" ? "tool_calls" : stopReason;
}

/** Builds a canonical input messages array from a single user prompt. */
export function userTextMessages(text: string): GenAiMessage[] {
  return [{ role: "user", parts: [{ type: "text", content: text }] }];
}

/** Builds a canonical output messages array from a single assistant text reply. */
export function assistantTextMessages(text: string): GenAiMessage[] {
  return [{ role: "assistant", parts: [{ type: "text", content: text }] }];
}

/**
 * Builds canonical `gen_ai.output.messages` from a pi assistant message's
 * content blocks. Text becomes `text` parts, thinking becomes `reasoning`
 * parts (surfaced separately by Sentry), and tool calls become `tool_call`
 * parts. Returns an empty array when there is nothing to record.
 */
export function buildOutputMessages(
  content: ReadonlyArray<Record<string, unknown>>,
  stopReason?: string,
): GenAiMessage[] {
  const parts: GenAiPart[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
      parts.push({ type: "text", content: c.text });
    } else if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.length > 0) {
      parts.push({ type: "reasoning", content: c.thinking });
    } else if (c.type === "toolCall") {
      parts.push({
        type: "tool_call",
        id: typeof c.id === "string" ? c.id : "",
        name: typeof c.name === "string" ? c.name : "",
        arguments: c.arguments,
      });
    }
  }
  if (parts.length === 0) {
    return [];
  }
  const message: GenAiMessage = { role: "assistant", parts };
  if (stopReason) {
    message.finish_reason = mapFinishReason(stopReason);
  }
  return [message];
}

export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return (
    m.role === "assistant" &&
    typeof m.model === "string" &&
    m.usage !== null &&
    typeof m.usage === "object"
  );
}
