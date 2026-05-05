import { describe, it, expect } from "vitest";
import { splitCommand, createSentryCLI, collectPaginated } from "../sentry-cli.ts";

describe("splitCommand", () => {
  it("splits basic args", () => {
    expect(splitCommand("issue list --limit 5")).toEqual(["issue", "list", "--limit", "5"]);
  });

  it("handles double-quoted strings", () => {
    expect(splitCommand('issue list --query "is:unresolved assigned:me"')).toEqual([
      "issue",
      "list",
      "--query",
      "is:unresolved assigned:me",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(splitCommand("issue list --query 'is:unresolved'")).toEqual([
      "issue",
      "list",
      "--query",
      "is:unresolved",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(splitCommand("")).toEqual([]);
  });

  it("handles extra whitespace", () => {
    expect(splitCommand("  auth   status  ")).toEqual(["auth", "status"]);
  });

  it("preserves content inside quotes with spaces", () => {
    expect(splitCommand('trace view "abc 123 def"')).toEqual(["trace", "view", "abc 123 def"]);
  });

  it("handles mixed quotes", () => {
    expect(splitCommand(`issue list --query "title:'my error'"`)).toEqual([
      "issue",
      "list",
      "--query",
      "title:'my error'",
    ]);
  });

  it("keeps escaped spaces in a single argument", () => {
    expect(splitCommand("trace view abc\\ 123")).toEqual(["trace", "view", "abc 123"]);
  });

  it("keeps escaped quotes inside double quotes", () => {
    expect(splitCommand('issue list --query "title=\\"my error\\""')).toEqual([
      "issue",
      "list",
      "--query",
      'title="my error"',
    ]);
  });

  it("treats an unterminated quote as part of the final argument", () => {
    expect(splitCommand('issue list --query "oops')).toEqual(["issue", "list", "--query", "oops"]);
  });
});

describe("createSentryCLI", () => {
  it("returns object with expected methods", () => {
    const cli = createSentryCLI();
    expect(typeof cli.run).toBe("function");
    expect(typeof cli.authStatus).toBe("function");
    expect(typeof cli.authLogin).toBe("function");
    expect(typeof cli.issueList).toBe("function");
    expect(typeof cli.orgList).toBe("function");
    expect(typeof cli.projectList).toBe("function");
    expect(typeof cli.projectKeys).toBe("function");
  });
});

describe("collectPaginated", () => {
  it("returns a bare array as-is when the fetcher does not paginate", async () => {
    const result = await collectPaginated(async () => [{ slug: "a" }, { slug: "b" }]);
    expect(result).toEqual([{ slug: "a" }, { slug: "b" }]);
  });

  it("unwraps a single paginated page with hasMore=false", async () => {
    const result = await collectPaginated(async () => ({
      data: [{ slug: "a" }],
      hasMore: false,
    }));
    expect(result).toEqual([{ slug: "a" }]);
  });

  it("walks pages until hasMore is false, threading nextCursor", async () => {
    const pages = [
      { data: [{ slug: "a" }], hasMore: true, nextCursor: "c1" },
      { data: [{ slug: "b" }], hasMore: true, nextCursor: "c2" },
      { data: [{ slug: "c" }], hasMore: false },
    ];
    const calls: (string | undefined)[] = [];
    let i = 0;
    const result = await collectPaginated<{ slug: string }>(async (cursor) => {
      calls.push(cursor);
      return pages[i++];
    });
    expect(result).toEqual([{ slug: "a" }, { slug: "b" }, { slug: "c" }]);
    expect(calls).toEqual([undefined, "c1", "c2"]);
  });

  it("stops when nextCursor is missing even if hasMore is true", async () => {
    const result = await collectPaginated(async () => ({
      data: [{ slug: "a" }],
      hasMore: true,
    }));
    expect(result).toEqual([{ slug: "a" }]);
  });

  it("returns [] when the wrapper has no data and no array", async () => {
    const result = await collectPaginated(async () => ({ hasMore: false }));
    expect(result).toEqual([]);
  });

  it("respects the pageLimit safety cap to avoid runaway loops", async () => {
    let count = 0;
    const result = await collectPaginated<{ slug: string }>(
      async () => {
        count++;
        return {
          data: [{ slug: `p${count}` }],
          hasMore: true,
          nextCursor: `c${count}`,
        };
      },
      { pageLimit: 3 },
    );
    expect(result).toHaveLength(3);
    expect(count).toBe(3);
  });
});
