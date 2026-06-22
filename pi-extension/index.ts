import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import * as Sentry from "@sentry/node-core/light";
import { initWithoutDefaultIntegrations, type LightNodeClient } from "@sentry/node-core/light";
import { conversationIdIntegration, getClient } from "@sentry/core";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.ts";
import { createLogger, getProjectName, getAgentName } from "./helpers.ts";
import { SessionTracer } from "./tracing.ts";

let sentryInitialized = false;
let initializedDsn: string | null = null;
let sharedClient: LightNodeClient | undefined;
let sharedClientRefCount = 0;
const beforeExitCleanups = new Set<() => void>();

function onBeforeExit(): void {
  for (const cleanup of beforeExitCleanups) {
    cleanup();
  }
}

type ExtensionErrorEvent = {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
};

type ExtensionErrorHandler = (event: ExtensionErrorEvent) => void;

function initSentry(
  config: ResolvedPluginConfig,
  logger: ReturnType<typeof createLogger>,
): LightNodeClient | undefined {
  if (sentryInitialized) {
    if (initializedDsn && initializedDsn !== config.dsn) {
      logger.warn("Sentry already initialized with different DSN", {
        initializedDsn,
        requestedDsn: config.dsn,
      });
    }
    return sharedClient ?? getClient<LightNodeClient>();
  }

  const client = initWithoutDefaultIntegrations({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
    sendDefaultPii: false,
    // Enable span streaming for real-time span emission
    traceLifecycle: "stream",
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.requestDataIntegration(),
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
      Sentry.onUnhandledRejectionIntegration({
        mode: "warn",
      }),
      conversationIdIntegration(),
    ],
    // Span streaming mode: beforeSendTransaction has no effect
    // Use beforeSendSpan with withStreamedSpan() if span modification is needed
  });

  sentryInitialized = true;
  initializedDsn = config.dsn;
  sharedClient = client;
  return client;
}

function retainClient(client: LightNodeClient | undefined): void {
  if (!client) {
    return;
  }
  sharedClientRefCount++;
}

async function releaseClient(client: LightNodeClient | undefined): Promise<void> {
  if (!client) {
    return;
  }

  sharedClientRefCount = Math.max(0, sharedClientRefCount - 1);
  if (sharedClientRefCount > 0) {
    return;
  }

  try {
    await client.close(5000);
  } finally {
    sharedClient = undefined;
    sentryInitialized = false;
    initializedDsn = null;
  }
}

function registerExtensionErrorCapture(
  pi: ExtensionAPI,
  logger: ReturnType<typeof createLogger>,
): void {
  const handler: ExtensionErrorHandler = (event) => {
    const err = new Error(
      `Extension error in ${event.extensionPath} during ${event.event}: ${event.error}`,
    );
    if (event.stack) err.stack = event.stack;
    Sentry.captureException(err, {
      tags: {
        "pi.extension.path": event.extensionPath,
        "pi.extension.event": event.event,
      },
    });
  };

  try {
    (pi.on as unknown as (event: string, handler: ExtensionErrorHandler) => void)(
      "extension_error",
      handler,
    );
  } catch (error) {
    logger.info("extension_error event not available; skipping sibling extension error capture", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default async function piSentryMonitor(pi: ExtensionAPI) {
  const logger = createLogger();
  const cwd = process.cwd();

  // Register init block renderer for conversation display
  pi.registerMessageRenderer("sentry-init", (message, { expanded }, theme) => {
    const d = message.details as
      | {
          monitoring: boolean;
          project?: string;
          agent?: string;
          environment?: string;
          source?: string;
          tracing?: boolean;
          inputs?: boolean;
          outputs?: boolean;
        }
      | undefined;

    const lines: string[] = [];

    if (!d?.monitoring) {
      lines.push(
        theme.inverse(theme.fg("warning", " ▲ SENTRY ")) +
          " " +
          theme.fg("muted", "inactive (no DSN configured)"),
      );
    } else {
      lines.push(
        theme.inverse(theme.fg("success", " ▲ SENTRY ")) +
          " " +
          theme.fg("success", "monitoring active"),
      );
      if (expanded) {
        const dim = (label: string, value: string) =>
          `  ${theme.fg("muted", label + ":")} ${value}`;
        if (d.project) lines.push(dim("Project", d.project));
        if (d.agent) lines.push(dim("Agent", d.agent));
        if (d.environment) lines.push(dim("Environment", d.environment));
        if (d.source) lines.push(dim("Config", d.source));
        const flags: string[] = [];
        if (d.tracing) flags.push("tracing");
        if (d.inputs) flags.push("inputs");
        if (d.outputs) flags.push("outputs");
        if (flags.length > 0) lines.push(dim("Capture", flags.join(", ")));
      }
    }

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  // Load config — if no DSN, register inactive mode and return
  const loaded = await loadPluginConfig(cwd, logger);

  if (!loaded) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
      pi.sendMessage({
        customType: "sentry-init",
        content: "Sentry extension loaded but inactive (no DSN configured)",
        display: true,
        details: { monitoring: false },
      });
    });
    return;
  }

  const config = loaded.config;
  const projectName = getProjectName(config, cwd);
  const agentName = getAgentName(config);
  const client = initSentry(config, logger);
  retainClient(client);
  const tracer = new SessionTracer(config, agentName, projectName);
  const beforeExitCleanup = () => {
    tracer.cleanupSession();
  };
  beforeExitCleanups.add(beforeExitCleanup);
  if (beforeExitCleanups.size === 1) {
    process.on("beforeExit", onBeforeExit);
  }

  registerExtensionErrorCapture(pi, logger);

  // Status bar flash state
  let uiContext: ExtensionUIContext | undefined;
  let statusFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingFlashCount = 0;
  let flashDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  function flashStatus(count: number): void {
    if (!uiContext || count === 0) return;
    if (statusFlashTimer) clearTimeout(statusFlashTimer);
    uiContext.setStatus("sentry", `▲ Sentry (sent ${count} event${count === 1 ? "" : "s"})`);
    statusFlashTimer = setTimeout(() => {
      uiContext?.setStatus("sentry", "▲ Sentry");
      statusFlashTimer = undefined;
    }, 5000);
  }

  /** Schedule a debounced flash for when spans are streamed. */
  function scheduleSpanFlash(): void {
    pendingFlashCount++;
    if (flashDebounceTimer) clearTimeout(flashDebounceTimer);
    flashDebounceTimer = setTimeout(() => {
      if (pendingFlashCount > 0) {
        flashStatus(pendingFlashCount);
      }
      pendingFlashCount = 0;
      flashDebounceTimer = undefined;
    }, 100);
  }

  // Report a handler failure to Sentry and the local log without crashing pi.
  function captureHandlerError(
    message: string,
    error: unknown,
    extra?: Record<string, unknown>,
  ): void {
    Sentry.captureException(error);
    logger.warn(message, {
      error: error instanceof Error ? error.message : String(error),
      ...extra,
    });
  }

  // --- Wire pi events to tracer ---

  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      tracer.setSession(sessionId, ctx.sessionManager.getSessionFile());
      Sentry.startSession();
      uiContext = ctx.ui;
      ctx.ui.setStatus("sentry", "▲ Sentry (started)");

      pi.sendMessage({
        customType: "sentry-init",
        content: `Sentry monitoring active. Session ID \`${sessionId}\` is attached to traces as \`pi.session.id\`.`,
        display: true,
        details: {
          monitoring: true,
          project: projectName,
          agent: agentName,
          environment: config.environment,
          source: loaded.source,
          tracing: config.tracesSampleRate > 0,
          inputs: config.recordInputs,
          outputs: config.recordOutputs,
        },
      });

      setTimeout(() => {
        if (!statusFlashTimer) {
          uiContext?.setStatus("sentry", "▲ Sentry");
        }
      }, 5000);
    } catch (error) {
      captureHandlerError("Failed to create session span", error);
    }
  });

  pi.on("session_switch", (_event, ctx) => {
    uiContext = ctx.ui;
    tracer.setSession(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
    tracer.resetSession();
  });

  pi.on("session_shutdown", async () => {
    try {
      beforeExitCleanups.delete(beforeExitCleanup);
      if (beforeExitCleanups.size === 0) {
        process.off("beforeExit", onBeforeExit);
      }
      tracer.cleanupSession();
      await releaseClient(client);
    } catch (error) {
      captureHandlerError("Failed to cleanup session on shutdown", error);
    }
  });

  pi.on("model_select", (event) => {
    try {
      tracer.onModelSelect(event);
    } catch (error) {
      captureHandlerError("Failed to capture model_select metadata", error);
    }
  });

  pi.on("tool_execution_start", (event) => {
    try {
      tracer.onToolStart(event);
    } catch (error) {
      captureHandlerError("Failed to start tool span", error, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  pi.on("tool_execution_end", (event) => {
    try {
      tracer.onToolEnd(event);
      scheduleSpanFlash();
    } catch (error) {
      captureHandlerError("Failed to finish tool span", error, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  pi.on("input", (event) => {
    tracer.onInput(event);
  });

  pi.on("message_start", (event) => {
    try {
      tracer.onMessageStart(event);
    } catch (error) {
      captureHandlerError("Failed to start request span", error);
    }
  });

  pi.on("message_end", (event, ctx) => {
    try {
      tracer.setContextUsage(ctx.getContextUsage());
      tracer.onMessageEnd(event);
      scheduleSpanFlash();
    } catch (error) {
      captureHandlerError("Failed to create message usage span", error);
    }
  });

  pi.on("turn_start", (event) => {
    tracer.onTurnStart(event);
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      tracer.setContextUsage(ctx.getContextUsage());
      const shouldFlush = tracer.onTurnEnd();
      if (!shouldFlush) return;

      // Spans are already streamed in real-time with traceLifecycle: 'stream'.
      // Flash any remaining count from cleanup session span.
      const flushedCount = tracer.resetSpanCount();
      flashStatus(flushedCount);
    } catch (error) {
      captureHandlerError("Failed to flush on turn_end", error);
    }
  });

  pi.on("agent_end", async () => {
    try {
      if (config.includeSessionEvents) {
        Sentry.addBreadcrumb({
          category: "pi.agent",
          level: "info",
          message: "agent_end",
        });
      }
    } catch (error) {
      captureHandlerError("Failed to add agent_end breadcrumb", error);
    }
  });
}
