# Maintenance Notes

## `extension_error` patch (still required)

The fixes in `patches/extension-error-event.patch` are applied to the
`@mariozechner/pi-coding-agent` dev dependency only by maintainers who run
`npm run patch:apply`. The patch has two halves:

1. **`extension_error` event delivery** — makes `ExtensionRunner.emitError`
   forward to extension handlers registered via `pi.on("extension_error", ...)`,
   and declares the `ExtensionErrorEvent` type + the `on("extension_error")`
   overload. **Still NOT upstream** in any published release (checked
   `@mariozechner/pi-coding-agent` 0.73.1 and `@earendil-works/pi-coding-agent`
   0.79.x — `emitError` still only notifies internal `errorListeners`, and the
   type/overload are absent). The sibling-extension error capture in
   `registerExtensionErrorCapture` (pi-extension/index.ts) depends on this, so
   the patch and the `pi.on(... as unknown ...)` cast must stay.
2. **Handler crash isolation** (the old `tool_call` fix) — wrapping event
   handlers in try/catch so a throwing handler can't crash pi. **This is now
   upstream**: the generic event loop already wraps handlers and routes errors
   through `emitError`. This half only remains because the pinned dev dependency
   (`@mariozechner/pi-coding-agent` ^0.64.0) predates it.

## When `extension_error` delivery lands upstream

Once a published release forwards `extension_error` to extension handlers and
ships the `ExtensionErrorEvent` type, do the cleanup:

1. Remove `patches/extension-error-event.patch`
2. Delete `scripts/apply-patches.mjs`
3. Remove `patch:apply` from `package.json`
4. Drop the `pi.on(... as unknown as ...)` cast in `pi-extension/index.ts`
5. Run `npm install && vp check && vp test`

## Scope migration (separate consideration)

The runtime now ships under `@earendil-works/pi-coding-agent` (pi 0.79.x) while
the dev dependency is still `@mariozechner/pi-coding-agent` (frozen at 0.73.1).
A future change may migrate the dev dependency to the `@earendil-works` scope;
verify the patch and type imports against that package's `dist` layout first.
