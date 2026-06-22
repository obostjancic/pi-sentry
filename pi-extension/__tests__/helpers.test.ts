import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  attachTokenUsage,
  detectSubagentName,
  isAssistantMessage,
  getProjectName,
  getAgentName,
  setSpanStatus,
  buildOutputMessages,
  userTextMessages,
  mapFinishReason,
} from "../helpers.ts";
import type { ResolvedPluginConfig } from "../config.ts";

function mockSpan() {
  const attrs: Record<string, string | number | boolean> = {};
  let statusCode: number | undefined;
  return {
    setAttribute: (key: string, value: string | number | boolean) => {
      attrs[key] = value;
    },
    setStatus: (status: { code: number }) => {
      statusCode = status.code;
    },
    spanContext: () => ({ traceId: "mock-trace-id" }),
    end: () => {},
    get attrs() {
      return attrs;
    },
    get statusCode() {
      return statusCode;
    },
  };
}

function makeConfig(overrides: Partial<ResolvedPluginConfig> = {}): ResolvedPluginConfig {
  return {
    dsn: "https://key@sentry.io/123",
    tracesSampleRate: 1,
    recordInputs: true,
    recordOutputs: true,
    maxAttributeLength: 12000,
    includeMessageUsageSpans: true,
    includeSessionEvents: true,
    tags: {},
    ...overrides,
  };
}

describe("attachTokenUsage", () => {
  it("computes totalInput as input + cacheRead + cacheWrite", () => {
    const span = mockSpan();
    const result = attachTokenUsage(span, {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 25,
      totalTokens: 375,
    });
    expect(result.totalInput).toBe(325); // 100 + 200 + 25
    expect(result.totalOutput).toBe(50);
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(325);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(span.attrs["gen_ai.usage.total_tokens"]).toBe(375);
    expect(span.attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(200);
    expect(span.attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(25);
  });

  it("does not set input_tokens when total is 0", () => {
    const span = mockSpan();
    attachTokenUsage(span, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.usage.total_tokens"]).toBeUndefined();
  });
});

describe("detectSubagentName", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("detects agent name from valid pi-subagent path", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/pi-subagent-abc123/worker.md"];
    expect(detectSubagentName()).toBe("worker");
  });

  it("returns undefined for non-matching directory", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/other-dir/worker.md"];
    expect(detectSubagentName()).toBeUndefined();
  });

  it("returns undefined when flag is missing", () => {
    process.argv = ["node", "pi"];
    expect(detectSubagentName()).toBeUndefined();
  });

  it("handles agent name without .md extension", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/pi-subagent-xyz/scout"];
    expect(detectSubagentName()).toBe("scout");
  });
});

describe("isAssistantMessage", () => {
  it("returns true for valid assistant message", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        model: "claude-3",
        usage: { input: 100, output: 50 },
      }),
    ).toBe(true);
  });

  it("returns false for non-assistant role", () => {
    expect(
      isAssistantMessage({
        role: "user",
        model: "claude-3",
        usage: { input: 100 },
      }),
    ).toBe(false);
  });

  it("returns false for missing model", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        usage: { input: 100 },
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isAssistantMessage(null)).toBe(false);
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  it("returns false for null usage", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        model: "claude-3",
        usage: null,
      }),
    ).toBe(false);
  });
});

describe("getProjectName", () => {
  it("uses config.projectName when set", () => {
    expect(getProjectName(makeConfig({ projectName: "my-project" }), "/some/path")).toBe(
      "my-project",
    );
  });

  it("falls back to basename of cwd", () => {
    expect(getProjectName(makeConfig(), "/home/user/my-app")).toBe("my-app");
  });

  it("returns 'pi-project' for empty basename", () => {
    expect(getProjectName(makeConfig(), "/")).toBe("pi-project");
  });
});

describe("getAgentName", () => {
  it("uses config.agentName when set", () => {
    expect(getAgentName(makeConfig({ agentName: "custom-agent" }))).toBe("custom-agent");
  });

  it("defaults to 'pi' when no config or subagent", () => {
    // Reset argv to not match subagent pattern
    const saved = process.argv;
    process.argv = ["node", "pi"];
    expect(getAgentName(makeConfig())).toBe("pi");
    process.argv = saved;
  });
});

describe("userTextMessages", () => {
  it("wraps a prompt in the canonical {role, parts} shape", () => {
    expect(userTextMessages("hello")).toEqual([
      { role: "user", parts: [{ type: "text", content: "hello" }] },
    ]);
  });
});

describe("mapFinishReason", () => {
  it("maps toolUse to tool_calls", () => {
    expect(mapFinishReason("toolUse")).toBe("tool_calls");
  });

  it("passes through other stop reasons", () => {
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("length")).toBe("length");
  });
});

describe("buildOutputMessages", () => {
  it("maps text, thinking, and tool calls to canonical parts", () => {
    const result = buildOutputMessages(
      [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "the answer" },
        { type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } },
      ],
      "toolUse",
    );
    expect(result).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "let me think" },
          { type: "text", content: "the answer" },
          { type: "tool_call", id: "call_1", name: "search", arguments: { q: "x" } },
        ],
        finish_reason: "tool_calls",
      },
    ]);
  });

  it("omits the finish_reason when no stop reason is given", () => {
    const result = buildOutputMessages([{ type: "text", text: "hi" }]);
    expect(result[0].finish_reason).toBeUndefined();
  });

  it("returns an empty array when there is no recordable content", () => {
    expect(buildOutputMessages([{ type: "text", text: "" }])).toEqual([]);
    expect(buildOutputMessages([])).toEqual([]);
  });
});

describe("setSpanStatus", () => {
  it("sets code 2 for errors", () => {
    const span = mockSpan();
    setSpanStatus(span, true);
    expect(span.statusCode).toBe(2);
  });

  it("sets code 1 for success", () => {
    const span = mockSpan();
    setSpanStatus(span, false);
    expect(span.statusCode).toBe(1);
  });
});
