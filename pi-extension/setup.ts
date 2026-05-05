import { constants as fsConstants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadPluginConfig } from "./config.ts";
import { createLogger } from "./helpers.ts";
import type { SentryCLI } from "./sentry-cli.ts";

const CONFIG_FILE = "sentry.json";

interface OrgSummary {
  slug: string;
  name?: string;
}

interface ProjectSummary {
  slug: string;
  name?: string;
}

interface ProjectKey {
  name?: string;
  dsn?: { public?: string };
}

export interface SentryCommandDeps {
  cli: SentryCLI;
  pi: ExtensionAPI;
}

export async function handleSentryCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: SentryCommandDeps,
): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "" || sub === "setup") {
    await runSetup(ctx, deps);
    return;
  }
  if (sub === "status") {
    await runStatus(ctx, deps);
    return;
  }
  if (sub === "reset") {
    await runReset(ctx, deps);
    return;
  }

  ctx.ui.notify(
    `Unknown subcommand "${sub}". Use /sentry, /sentry status, or /sentry reset.`,
    "error",
  );
}

async function runSetup(ctx: ExtensionCommandContext, deps: SentryCommandDeps): Promise<void> {
  const { cli, pi } = deps;

  ctx.ui.setStatus("sentry", "▲ Sentry (checking auth...)");
  const auth = await cli.authStatus();
  if (auth.code !== 0) {
    ctx.ui.notify("Not authenticated with Sentry — opening browser to log in.", "info");
    ctx.ui.setStatus("sentry", "▲ Sentry (logging in...)");
    const login = await cli.authLogin();
    if (login.code !== 0) {
      ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
      ctx.ui.notify(
        `Sentry login failed: ${login.stderr || "(no details)"}`,
        "error",
      );
      return;
    }
  }

  ctx.ui.setStatus("sentry", "▲ Sentry (listing organizations...)");
  const orgs = await safeCall(() => cli.orgList(), ctx, "Failed to list organizations");
  if (!orgs) return;
  const orgList = parseOrgs(orgs);
  if (orgList.length === 0) {
    ctx.ui.notify("No Sentry organizations available for this account.", "error");
    return;
  }

  const orgSlug = await pickOne(ctx, "Select Sentry organization", orgList, (o) =>
    o.name ? `${o.name} (${o.slug})` : o.slug,
  );
  if (!orgSlug) {
    ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
    return;
  }

  ctx.ui.setStatus("sentry", "▲ Sentry (listing projects...)");
  const projectsRaw = await safeCall(
    () => cli.projectList(orgSlug),
    ctx,
    `Failed to list projects in ${orgSlug}`,
  );
  if (!projectsRaw) return;
  const projects = parseProjects(projectsRaw);
  if (projects.length === 0) {
    ctx.ui.notify(`No projects found in ${orgSlug}.`, "error");
    return;
  }

  const projectSlug = await pickOne(ctx, "Select Sentry project", projects, (p) =>
    p.name ? `${p.name} (${p.slug})` : p.slug,
  );
  if (!projectSlug) {
    ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
    return;
  }

  ctx.ui.setStatus("sentry", "▲ Sentry (fetching DSN...)");
  const keysRaw = await safeCall(
    () => cli.projectKeys(orgSlug, projectSlug),
    ctx,
    "Failed to fetch project keys",
  );
  if (!keysRaw) return;
  const keys = parseKeys(keysRaw);
  const dsn = keys[0]?.dsn?.public;
  if (!dsn) {
    ctx.ui.notify(
      `No DSN keys returned for ${orgSlug}/${projectSlug}. Create one in Sentry first.`,
      "error",
    );
    return;
  }

  const env = await ctx.ui.input(
    "Sentry environment (optional, press Enter to skip)",
    "e.g. development",
  );

  const configDir = join(ctx.cwd, ".pi");
  const configPath = join(configDir, CONFIG_FILE);
  const payload: Record<string, unknown> = { dsn };
  if (env && env.trim().length > 0) {
    payload.environment = env.trim();
  }

  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch (err) {
    ctx.ui.notify(`Failed to write ${configPath}: ${String(err)}`, "error");
    return;
  }

  pi.sendMessage({
    customType: "sentry-init",
    content: `Wrote Sentry config to ${configPath}. Reloading extensions to activate monitoring.`,
    display: true,
    details: {
      monitoring: true,
      project: projectSlug,
      environment: typeof payload.environment === "string" ? payload.environment : undefined,
      source: configPath,
    },
  });

  await ctx.reload();
}

async function runStatus(ctx: ExtensionCommandContext, deps: SentryCommandDeps): Promise<void> {
  const { cli, pi } = deps;
  ctx.ui.setStatus("sentry", "▲ Sentry (checking status...)");

  const auth = await cli.authStatus();
  const lines: string[] = [];
  lines.push(
    auth.code === 0
      ? "Auth: authenticated"
      : `Auth: not authenticated${auth.stderr ? ` (${auth.stderr.split("\n")[0]})` : ""}`,
  );

  const loaded = await loadPluginConfig(ctx.cwd, createLogger());
  if (!loaded) {
    lines.push("Config: none found — run /sentry to set up");
  } else {
    lines.push(`Config: ${loaded.source}`);
    try {
      const host = new URL(loaded.config.dsn).host;
      lines.push(`  DSN host: ${host}`);
    } catch {
      lines.push("  DSN: (invalid)");
    }
    if (loaded.config.environment) lines.push(`  Environment: ${loaded.config.environment}`);
    lines.push(`  Sample rate: ${loaded.config.tracesSampleRate}`);
    lines.push(
      `  Capture: inputs=${loaded.config.recordInputs} outputs=${loaded.config.recordOutputs}`,
    );
  }

  pi.sendMessage({
    customType: "sentry-status",
    content: lines.join("\n"),
    display: true,
    details: { lines },
  });

  ctx.ui.setStatus(
    "sentry",
    loaded ? "▲ Sentry" : "▲ Sentry (no DSN configured)",
  );
}

async function runReset(ctx: ExtensionCommandContext, deps: SentryCommandDeps): Promise<void> {
  const configPath = join(ctx.cwd, ".pi", CONFIG_FILE);
  const exists = await fileExists(configPath);
  if (!exists) {
    ctx.ui.notify(`No ${configPath} to remove.`, "info");
    return;
  }

  const ok = await ctx.ui.confirm("Reset Sentry config?", `Delete ${configPath}?`);
  if (!ok) return;

  try {
    await unlink(configPath);
  } catch (err) {
    ctx.ui.notify(`Failed to delete ${configPath}: ${String(err)}`, "error");
    return;
  }

  deps.pi.sendMessage({
    customType: "sentry-init",
    content: `Removed ${configPath}. Reloading extensions.`,
    display: true,
    details: { monitoring: false },
  });

  await ctx.reload();
}

async function safeCall<T>(
  fn: () => Promise<T>,
  ctx: ExtensionCommandContext,
  errorPrefix: string,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`${errorPrefix}: ${msg}`, "error");
    return undefined;
  }
}

async function pickOne<T extends { slug: string }>(
  ctx: ExtensionCommandContext,
  title: string,
  items: T[],
  format: (item: T) => string,
): Promise<string | undefined> {
  if (items.length === 1) return items[0].slug;
  const labels = items.map(format);
  const choice = await ctx.ui.select(title, labels);
  if (choice === undefined) return undefined;
  const idx = labels.indexOf(choice);
  return idx >= 0 ? items[idx].slug : undefined;
}

function parseOrgs(raw: unknown): OrgSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .filter((o) => typeof o.slug === "string" && o.slug.length > 0)
    .map((o) => ({
      slug: o.slug as string,
      name: typeof o.name === "string" ? o.name : undefined,
    }));
}

function parseProjects(raw: unknown): ProjectSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .filter((p) => typeof p.slug === "string" && p.slug.length > 0)
    .map((p) => ({
      slug: p.slug as string,
      name: typeof p.name === "string" ? p.name : undefined,
    }));
}

function parseKeys(raw: unknown): ProjectKey[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is Record<string, unknown> => !!k && typeof k === "object")
    .map((k) => {
      const dsn = k.dsn && typeof k.dsn === "object" ? (k.dsn as Record<string, unknown>) : undefined;
      return {
        name: typeof k.name === "string" ? k.name : undefined,
        dsn: dsn && typeof dsn.public === "string" ? { public: dsn.public } : undefined,
      };
    });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
