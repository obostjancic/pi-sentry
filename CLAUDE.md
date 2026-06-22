# Sentry Extension

Sentry observability extension for [pi](https://github.com/badlogic/pi-mono). Instruments agent sessions as distributed traces and captures errors. Scope is intentionally minimal: error + tracing only — no metrics, no CLI tool, no setup wizard.

## Structure

```
pi-extension/          ← TypeScript source
  index.ts             ← Main extension: config loading, event wiring, Sentry init
  config.ts            ← Config loading, interfaces, defaults, env overrides
  helpers.ts           ← Pure utility functions (logger, naming, token math, type guards)
  tracing.ts           ← SessionTracer class: span lifecycle and event handling
  serialize.ts         ← Attribute redaction/truncation
  __tests__/           ← Vitest tests (run via `vp test`)
scripts/               ← Utility scripts
```

## Verify

```bash
vp check       # format + lint + type check — always run after changes
vp test        # run tests
```

Individual checks:
```bash
vp fmt          # oxfmt — auto-format in place
vp lint         # oxlint — fast linter
npm run typecheck  # TypeScript type checking
vp test --watch # run tests in watch mode
```

All checks must pass before committing (enforced by pre-commit hook). No build step — pi loads TypeScript directly.

## Key Conventions

### Dependencies

- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` are **devDependencies only** — provided by pi at runtime. Never add them to `dependencies`.
- `@sentry/node-core`, `@sentry/core`, `strip-json-comments` are real runtime dependencies.
- `vite-plus` is the unified toolchain — provides vitest, oxlint, oxfmt via `vp` commands.

### Extension Architecture

- Monitoring (tracing, spans, error capture) only activates when a DSN is configured in `.pi/sentry.json`. Without a DSN the extension stays inactive.
- **`index.ts`** is thin wiring — it loads config, inits Sentry, creates a `SessionTracer`, and wires `pi.on()` events to tracer methods.
- **`tracing.ts`** (`SessionTracer` class) owns all span state and lifecycle. It has no dependency on pi's `ExtensionAPI`.
- **`helpers.ts`** contains pure functions with no Sentry SDK imports.

### Span Attributes

Spans must follow the canonical [Sentry `gen_ai.*` conventions](https://getsentry.github.io/sentry-conventions/attributes/gen_ai/) — **never emit attributes marked deprecated there.** When adding/changing attributes, check the convention's JSON (`sentry-conventions/model/attributes/gen_ai/`) for the current key and `deprecation.replacement`. Message content uses the `{role, parts: [{type, content}]}` shape via the `buildOutputMessages` / `userTextMessages` helpers in `helpers.ts`. pi-only metadata is namespaced under `pi.*`.

### Config Fields

When adding a new config field, update all four places in `config.ts`:
1. `PluginConfig` interface (optional)
2. `ResolvedPluginConfig` interface (required)
3. `DEFAULTS` object
4. `normalizeConfig()` return value
5. `addEnvOverrides()` with a `PI_SENTRY_*` env var

### Testing

Tests live in `pi-extension/__tests__/` and run via `vp test` (Vitest bundled in vite-plus). High-value tests cover:
- `serialize.test.ts` — redaction, truncation, edge cases
- `config.test.ts` — validation, defaults, env overrides
- `helpers.test.ts` — token math, subagent detection, type guards

## Demo & Testing

Test the extension locally without installing:
```bash
pi -e ./pi-extension/index.ts
```

## Naming

- **Agent name**: defaults to `pi` (not the project directory). Subagents show as `pi/<agent>`.
- **Project name**: defaults to `basename(cwd)`. Used for `pi.project.name` span attribute.
