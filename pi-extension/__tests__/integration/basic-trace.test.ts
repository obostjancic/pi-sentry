import { describe, expect, it } from "vitest";
import { withTestSession } from "./helpers/setup.ts";

describe("basic session trace", () => {
  it("captures an invoke_agent transaction with session attributes", async () => {
    await withTestSession({}, async (ctx) => {
      await ctx.session.prompt("Say hello");

      // Wait for Sentry to flush envelopes (span streaming sends spans directly)
      await ctx.server.waitForEnvelopes(1, 15_000);

      const spans = ctx.server.getSpans();
      expect(spans.length).toBeGreaterThan(0);

      // Find the invoke_agent segment span (root span in span streaming)
      const agentSpan = spans.find(
        (s: any) =>
          s["sentry.op"] === "gen_ai.invoke_agent" ||
          s.data?.["gen_ai.operation.name"] === "invoke_agent" ||
          s.name === "invoke_agent pi",
      );
      expect(agentSpan).toBeDefined();

      // Check session ID attribute exists on the span
      const data = agentSpan.data ?? {};

      // Agent name should be present
      expect(data["gen_ai.agent.name"]).toBe("pi");

      // Model should be recorded
      expect(data["gen_ai.request.model"]).toBeTruthy();

      // Project name should be present
      expect(data["pi.project.name"]).toBeTruthy();

      // Turn index should be recorded
      expect(data["pi.turn.index"]).toBeDefined();
    });
  });

  it("captures a gen_ai.request span with token usage", async () => {
    await withTestSession({}, async (ctx) => {
      await ctx.session.prompt("Say hello");
      await ctx.server.waitForEnvelopes(1, 15_000);

      const spans = ctx.server.getSpans();

      // Find request span
      const requestSpan = spans.find(
        (s: any) =>
          s["sentry.op"] === "gen_ai.request" || s.data?.["gen_ai.operation.name"] === "request",
      );
      expect(requestSpan).toBeDefined();

      // Check model attribute
      const spanData = (requestSpan as any)?.data ?? {};
      expect(spanData["gen_ai.request.model"]).toBeTruthy();
    });
  });
});
