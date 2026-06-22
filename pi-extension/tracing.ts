import * as Sentry from "@sentry/node-core/light";
import { setConversationId } from "@sentry/core";
import type { ResolvedPluginConfig } from "./config.ts";
import { serializeAttribute } from "./serialize.ts";
import {
  setSpanStatus,
  attachTokenUsage,
  isAssistantMessage,
  buildOutputMessages,
  userTextMessages,
  assistantTextMessages,
  mapFinishReason,
} from "./helpers.ts";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

export interface ContextUsageSnapshot {
  contextWindow: number;
  percent: number | null;
}

export class SessionTracer {
  private sessionSpan: SentrySpan | undefined;
  private modelId = "unknown";
  private providerId = "unknown";
  private readonly toolSpans = new Map<string, SentrySpan>();
  private readonly requestSpans = new Map<number, SentrySpan>();
  private readonly completedMessages = new Set<number>();
  private lastUserPrompt: string | undefined;
  private lastAssistantResponse: string | undefined;
  private aggregateInputTokens = 0;
  private aggregateOutputTokens = 0;
  private sessionId: string | undefined;
  private sessionFilePath: string | undefined;
  private turnIndex = 0;
  private turnHadToolCalls = false;
  private lastContextUsage: ContextUsageSnapshot | undefined;

  /** Number of spans ended since the last resetSpanCount() call. */
  spanCount = 0;

  constructor(
    private readonly config: ResolvedPluginConfig,
    private readonly agentName: string,
    private readonly projectName: string,
  ) {}

  setSession(sessionId: string, sessionFilePath: string | undefined): void {
    this.sessionId = sessionId;
    this.sessionFilePath = sessionFilePath;
    setConversationId(sessionId);
  }

  resetSession(): void {
    this.turnIndex = 0;
  }

  /** Sets model/provider attributes once the model is known. */
  private applyResolvedModel(span: SentrySpan): void {
    if (this.modelId === "unknown") return;
    span.setAttribute("gen_ai.request.model", this.modelId);
    span.setAttribute("gen_ai.response.model", this.modelId);
    span.setAttribute("gen_ai.provider.name", this.providerId);
  }

  /** Sets context-window attributes from the latest usage snapshot. */
  private applyContextUsage(span: SentrySpan): void {
    const usage = this.lastContextUsage;
    if (!usage) return;
    span.setAttribute("gen_ai.context.window_size", usage.contextWindow);
    if (usage.percent !== null) {
      span.setAttribute("gen_ai.context.utilization", usage.percent / 100);
    }
  }

  /** Records the current user prompt as input messages, when opted in. */
  private recordInputMessages(span: SentrySpan): void {
    if (!this.config.recordInputs || !this.lastUserPrompt) return;
    span.setAttribute(
      "gen_ai.input.messages",
      serializeAttribute(userTextMessages(this.lastUserPrompt), this.config.maxAttributeLength),
    );
  }

  /** Starts a `gen_ai.chat` span for an LLM request with the common attributes. */
  private startChatSpan(parentSpan: SentrySpan, model: string): SentrySpan {
    return Sentry.startInactiveSpan({
      parentSpan,
      op: "gen_ai.chat",
      name: `chat ${model}`,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "gen_ai.agent.name": this.agentName,
        "gen_ai.provider.name": this.providerId,
        "pi.project.name": this.projectName,
        ...this.config.tags,
      },
    });
  }

  private ensureSessionSpan(): SentrySpan {
    if (this.sessionSpan) {
      return this.sessionSpan;
    }

    this.sessionSpan = Sentry.startNewTrace(() => {
      if (this.sessionId) {
        setConversationId(this.sessionId);
      }

      const span = Sentry.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${this.agentName}`,
        forceTransaction: true,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": this.agentName,
          "gen_ai.request.model": this.modelId,
          "gen_ai.provider.name": this.providerId,
          "pi.project.name": this.projectName,
          "pi.capture.session_events": this.config.includeSessionEvents,
          "pi.turn.index": this.turnIndex,
          ...(this.sessionId ? { "pi.session.id": this.sessionId } : {}),
          ...(this.sessionFilePath ? { "pi.session.file": this.sessionFilePath } : {}),
          ...this.config.tags,
        },
      });
      this.recordInputMessages(span);
      return span;
    });

    return this.sessionSpan;
  }

  cleanupSession(): void {
    for (const [key, span] of this.toolSpans) {
      setSpanStatus(span, false);
      span.end();
      this.toolSpans.delete(key);
    }

    for (const [key, span] of this.requestSpans) {
      this.applyResolvedModel(span);
      setSpanStatus(span, false);
      span.end();
      this.requestSpans.delete(key);
    }

    if (this.sessionSpan) {
      this.applyResolvedModel(this.sessionSpan);
      if (this.config.recordOutputs && this.lastAssistantResponse) {
        this.sessionSpan.setAttribute(
          "gen_ai.output.messages",
          serializeAttribute(
            assistantTextMessages(this.lastAssistantResponse),
            this.config.maxAttributeLength,
          ),
        );
      }
      if (this.aggregateInputTokens > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.input_tokens", this.aggregateInputTokens);
      }
      if (this.aggregateOutputTokens > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.output_tokens", this.aggregateOutputTokens);
      }
      const aggregateTotal = this.aggregateInputTokens + this.aggregateOutputTokens;
      if (aggregateTotal > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.total_tokens", aggregateTotal);
      }
      this.applyContextUsage(this.sessionSpan);
    }

    const session = Sentry.getIsolationScope().getSession();
    if (session && session.status === "ok") {
      Sentry.endSession();
    }

    if (this.sessionSpan) {
      setSpanStatus(this.sessionSpan, false);
      this.sessionSpan.end();
    }
    this.sessionSpan = undefined;
    this.completedMessages.clear();
    this.aggregateInputTokens = 0;
    this.aggregateOutputTokens = 0;
  }

  onModelSelect(event: { model: { id: string; provider: string } }): void {
    this.modelId = event.model.id;
    this.providerId = event.model.provider;

    if (this.sessionSpan) {
      this.sessionSpan.setAttribute("gen_ai.request.model", this.modelId);
      this.sessionSpan.setAttribute("gen_ai.provider.name", this.providerId);
    }
  }

  onToolStart(event: { toolCallId: string; toolName: string; args: string }): void {
    this.turnHadToolCalls = true;
    const parentSpan = this.ensureSessionSpan();

    const span = Sentry.startInactiveSpan({
      parentSpan,
      op: "gen_ai.execute_tool",
      name: `execute_tool ${event.toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.agent.name": this.agentName,
        "gen_ai.request.model": this.modelId,
        "gen_ai.tool.name": event.toolName,
        "gen_ai.provider.name": this.providerId,
        "pi.tool_call.id": event.toolCallId,
        "pi.project.name": this.projectName,
        ...this.config.tags,
      },
    });

    if (this.config.recordInputs) {
      span.setAttribute(
        "gen_ai.tool.call.arguments",
        serializeAttribute(event.args, this.config.maxAttributeLength),
      );
    }

    this.toolSpans.set(event.toolCallId, span);
  }

  onToolEnd(event: {
    toolCallId: string;
    toolName: string;
    result: string;
    isError: boolean;
  }): void {
    const span = this.toolSpans.get(event.toolCallId);
    if (!span) return;

    if (this.config.recordOutputs) {
      span.setAttribute(
        "gen_ai.tool.call.result",
        serializeAttribute(event.result, this.config.maxAttributeLength),
      );
    }

    setSpanStatus(span, event.isError);
    span.end();
    this.toolSpans.delete(event.toolCallId);
    this.spanCount++;
  }

  onInput(event: { text?: string }): void {
    if (typeof event.text === "string") {
      this.lastUserPrompt = event.text;
    }
    if (this.sessionSpan) {
      this.cleanupSession();
    }
    this.lastAssistantResponse = undefined;
    this.turnHadToolCalls = false;
    this.aggregateInputTokens = 0;
    this.aggregateOutputTokens = 0;
  }

  onMessageStart(event: { message: unknown }): void {
    if (!this.config.includeMessageUsageSpans) return;

    const msg = event.message as Record<string, unknown>;
    if (msg.role !== "assistant") return;

    const timestamp = msg.timestamp as number;
    if (this.requestSpans.has(timestamp)) return;

    const parentSpan = this.ensureSessionSpan();
    const spanModel =
      typeof msg.model === "string" && msg.model.length > 0 ? msg.model : this.modelId;

    const requestSpan = this.startChatSpan(parentSpan, spanModel);
    this.recordInputMessages(requestSpan);
    this.requestSpans.set(timestamp, requestSpan);
  }

  onMessageEnd(event: { message: unknown }): void {
    if (!this.config.includeMessageUsageSpans) return;

    const msg = event.message;
    if (!isAssistantMessage(msg)) return;

    if (this.completedMessages.has(msg.timestamp)) return;
    this.completedMessages.add(msg.timestamp);

    this.modelId = msg.model;
    this.providerId = msg.provider;

    let usageSpan = this.requestSpans.get(msg.timestamp);
    if (usageSpan) {
      this.requestSpans.delete(msg.timestamp);
      usageSpan.setAttribute("gen_ai.request.model", msg.model);
      usageSpan.setAttribute("gen_ai.response.model", msg.model);
      usageSpan.setAttribute("gen_ai.provider.name", msg.provider);
      usageSpan.updateName(`chat ${msg.model}`);
    } else {
      usageSpan = this.startChatSpan(this.ensureSessionSpan(), msg.model);
    }

    if (msg.responseId) {
      usageSpan.setAttribute("gen_ai.response.id", msg.responseId);
    }
    if (msg.stopReason) {
      usageSpan.setAttribute("gen_ai.response.finish_reasons", mapFinishReason(msg.stopReason));
    }

    const { totalInput, totalOutput } = attachTokenUsage(usageSpan, msg.usage);
    this.aggregateInputTokens += totalInput;
    this.aggregateOutputTokens += totalOutput;

    this.applyContextUsage(usageSpan);
    this.recordInputMessages(usageSpan);

    if (this.config.recordOutputs && msg.content) {
      const outputMessages = buildOutputMessages(
        msg.content as unknown as ReadonlyArray<Record<string, unknown>>,
        msg.stopReason,
      );
      if (outputMessages.length > 0) {
        usageSpan.setAttribute(
          "gen_ai.output.messages",
          serializeAttribute(outputMessages, this.config.maxAttributeLength),
        );
        const text = outputMessages[0].parts
          .filter((p): p is { type: "text"; content: string } => p.type === "text")
          .map((p) => p.content)
          .join("\n");
        if (text.length > 0) {
          this.lastAssistantResponse = text;
        }
      }
    }
    setSpanStatus(usageSpan, false);
    usageSpan.end();
    this.spanCount++;
  }

  setContextUsage(usage: ContextUsageSnapshot | undefined): void {
    if (usage) {
      this.lastContextUsage = usage;
    }
  }

  onTurnStart(event: { turnIndex: number }): void {
    this.turnIndex = event.turnIndex;
  }

  /** Returns true if the caller should flush (final text response, no more turns). */
  onTurnEnd(): boolean {
    if (this.turnHadToolCalls) {
      this.turnHadToolCalls = false;
      return false;
    }

    this.cleanupSession();
    this.spanCount++;
    this.turnHadToolCalls = false;
    return true;
  }

  /** Returns count of spans sent since last reset() and resets counter. */
  resetSpanCount(): number {
    const count = this.spanCount;
    this.spanCount = 0;
    return count;
  }
}
