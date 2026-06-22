import { describe, expect, it } from "vitest";
import { withTestSession } from "./helpers/setup.ts";

describe("no DSN configured", () => {
  it("sends no envelopes when monitoring is inactive", async () => {
    await withTestSession({ dsn: null }, async (ctx) => {
      await ctx.session.prompt("Say hello");

      // Give time for any envelopes that shouldn't arrive
      await new Promise((r) => setTimeout(r, 2_000));

      expect(ctx.server.envelopes.length).toBe(0);
    });
  });
});
