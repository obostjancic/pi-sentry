export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SentryCLI {
  run(command: string, options?: { timeout?: number }): Promise<CLIResult>;
  authStatus(): Promise<CLIResult>;
  authLogin(): Promise<CLIResult>;
  issueList(options?: { limit?: number; query?: string }): Promise<unknown>;
  orgList(): Promise<unknown>;
  projectList(orgSlug: string): Promise<unknown>;
  projectKeys(orgSlug: string, projectSlug: string): Promise<unknown>;
}

/**
 * Split a command string into args, respecting quotes and simple backslash escapes.
 * e.g. `issue list --query "is:unresolved assigned:me"` → ["issue", "list", "--query", "is:unresolved assigned:me"]
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      args.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      pushCurrent();
    } else if (ch === "\\") {
      escaped = true;
    } else {
      current += ch;
    }
  }

  if (escaped) {
    current += "\\";
  }

  pushCurrent();
  return args;
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

interface PaginatedPage<T> {
  data?: T[];
  hasMore?: boolean;
  nextCursor?: string;
}

/**
 * Walks Sentry's cursor-based pagination, collecting items into a single array.
 *
 * Sentry list endpoints return either a bare array (older shapes / some endpoints)
 * or a `{ data, hasMore, nextCursor }` wrapper. Without unwrapping the wrapper,
 * callers that did `Array.isArray(raw)` would silently see zero results — which
 * is exactly what made the setup wizard report "No projects found" for orgs that
 * had any projects at all.
 *
 * `pageLimit` is a safety cap to avoid runaway loops if `hasMore` is stuck `true`.
 */
export async function collectPaginated<T>(
  fetchPage: (cursor: string | undefined) => Promise<PaginatedPage<T> | T[] | unknown>,
  options: { pageLimit?: number } = {},
): Promise<T[]> {
  const max = options.pageLimit ?? 50;
  const all: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const page = await fetchPage(cursor);
    if (Array.isArray(page)) return all.length === 0 ? (page as T[]) : [...all, ...(page as T[])];
    const wrapper = (page ?? {}) as PaginatedPage<T>;
    if (Array.isArray(wrapper.data)) all.push(...wrapper.data);
    if (!wrapper.hasMore || !wrapper.nextCursor) return all;
    cursor = wrapper.nextCursor;
  }
  return all;
}

/**
 * Why dynamic import? The `sentry` package bundles @sentry/node-core which
 * registers ESM loader hooks (import-in-the-middle) and diagnostics_channel
 * subscriptions the moment it's imported. A top-level `import ... from "sentry"`
 * would run during pi's extension loading phase — before other extensions have
 * been loaded — and corrupt their module resolution ("Cannot find package" errors
 * for @mariozechner/pi-ai, @sinclair/typebox, etc.).
 *
 * By deferring to a dynamic import() we push SDK initialization to first actual
 * use (when the sentry tool is invoked or a background query fires), safely after
 * all extensions are loaded. The result is cached so subsequent calls are free.
 */
async function loadSDK() {
  const { createSentrySDK, SentryError } = await import("sentry");
  return { sdk: createSentrySDK(), SentryError };
}

function formatError(
  error: unknown,
  fallbackPrefix: string,
  SentryError: new (...args: any[]) => Error & { exitCode: number; stderr: string },
): CLIResult {
  if (error instanceof SentryError) {
    const sentryErr = error as Error & { exitCode: number; stderr: string };
    return {
      stdout: "",
      stderr: [sentryErr.message, sentryErr.stderr].filter(Boolean).join("\n"),
      code: sentryErr.exitCode ?? 1,
    };
  }
  return { stdout: "", stderr: `${fallbackPrefix}: ${String(error)}`, code: 1 };
}

export function createSentryCLI(): SentryCLI {
  // Lazy-load once, cache the promise so all methods share the same SDK instance
  let loaded: ReturnType<typeof loadSDK> | undefined;
  function getSDK() {
    loaded ??= loadSDK();
    return loaded;
  }

  return {
    async run(command, _options) {
      const { sdk, SentryError } = await getSDK();
      try {
        const args = splitCommand(command);
        const result = await sdk.run(...args);
        return { stdout: formatResult(result), stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Sentry CLI error", SentryError);
      }
    },

    async authStatus() {
      const { sdk, SentryError } = await getSDK();
      try {
        const result = await sdk.auth.status();
        return { stdout: formatResult(result), stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Auth status error", SentryError);
      }
    },

    async authLogin() {
      const { sdk, SentryError } = await getSDK();
      try {
        await sdk.auth.login();
        return { stdout: "Successfully authenticated", stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Auth login error", SentryError);
      }
    },

    async issueList(options) {
      const { sdk } = await getSDK();
      return await sdk.issue.list(options);
    },

    async orgList() {
      const { sdk } = await getSDK();
      return await sdk.org.list();
    },

    async projectList(orgSlug) {
      const { sdk } = await getSDK();
      return await collectPaginated((cursor) =>
        sdk.project.list({ orgProject: orgSlug, limit: 100, cursor }),
      );
    },

    async projectKeys(orgSlug, projectSlug) {
      const { sdk } = await getSDK();
      return await sdk.api({ endpoint: `/api/0/projects/${orgSlug}/${projectSlug}/keys/` });
    },
  };
}
