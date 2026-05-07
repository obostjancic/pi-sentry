import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface EnvelopeItem {
  header: Record<string, unknown>;
  payload: Record<string, unknown> | string;
}

export interface Envelope {
  header: Record<string, unknown>;
  items: EnvelopeItem[];
}

export interface EnvelopeServer {
  port: number;
  dsn: string;
  envelopes: Envelope[];
  getSpans(): Record<string, unknown>[];
  getTransactions(): Record<string, unknown>[];
  getErrorEvents(): Record<string, unknown>[];
  getSessions(): Record<string, unknown>[];
  waitForEnvelopes(count: number, timeoutMs?: number): Promise<Envelope[]>;
  clear(): void;
  close(): Promise<void>;
}

function parseEnvelopeBody(body: string): Envelope | null {
  const lines = body.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  const items: EnvelopeItem[] = [];
  let i = 1;
  while (i < lines.length) {
    let itemHeader: Record<string, unknown>;
    try {
      itemHeader = JSON.parse(lines[i]);
    } catch {
      i++;
      continue;
    }
    i++;

    if (i < lines.length) {
      let payload: Record<string, unknown> | string;
      try {
        payload = JSON.parse(lines[i]);
      } catch {
        payload = lines[i];
      }
      items.push({ header: itemHeader, payload });
      i++;
    }
  }

  return { header, items };
}

export async function createEnvelopeServer(): Promise<EnvelopeServer> {
  const envelopes: Envelope[] = [];
  let waitResolvers: Array<{ count: number; resolve: () => void }> = [];

  function checkWaiters() {
    for (const waiter of waitResolvers) {
      if (envelopes.length >= waiter.count) {
        waiter.resolve();
      }
    }
    waitResolvers = waitResolvers.filter((w) => envelopes.length < w.count);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const envelope = parseEnvelopeBody(body);
        if (envelope) {
          envelopes.push(envelope);
          checkWaiters();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"id":"mock"}');
      });
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const dsn = `http://testkey@127.0.0.1:${port}/1`;

  return {
    port,
    dsn,
    envelopes,

    getSpans() {
      const spans: Record<string, unknown>[] = [];
      for (const env of envelopes) {
        for (const item of env.items) {
          const payload = item.payload as any;

          // Span streaming format (v2): type === "span"
          if (item.header.type === "span" && typeof payload === "object") {
            if (payload.items && Array.isArray(payload.items)) {
              // Span v2 format with items array - flatten attribute values
              for (const span of payload.items) {
                const flatSpan: Record<string, unknown> = { ...span };
                // Flatten attributes: {key: {value: "...", type: "string"}} -> {key: "..."}
                if (span.attributes && typeof span.attributes === "object") {
                  const flatAttrs: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(span.attributes)) {
                    if (v && typeof v === "object" && "value" in v) {
                      flatAttrs[k] = (v as any).value;
                    } else {
                      flatAttrs[k] = v;
                    }
                  }
                  flatSpan.data = flatAttrs;
                  // Copy key attributes to top-level for convenience (matches legacy format)
                  if (flatAttrs["sentry.op"]) {
                    (flatSpan as any)["sentry.op"] = flatAttrs["sentry.op"];
                  } else if (flatAttrs["gen_ai.operation.name"]) {
                    (flatSpan as any)["sentry.op"] = "gen_ai." + flatAttrs["gen_ai.operation.name"];
                  }
                  if (flatAttrs["gen_ai.operation.name"]) {
                    (flatSpan as any)["op"] = "gen_ai." + flatAttrs["gen_ai.operation.name"];
                  }
                }
                spans.push(flatSpan);
              }
            }
          }

          // Legacy transaction format: type === "transaction"
          if (
            typeof item.payload === "object" &&
            item.payload !== null &&
            (item.header.type === "transaction" || (item.payload as any).type === "transaction")
          ) {
            const txPayload = item.payload as any;
            // The transaction itself is a span
            if (txPayload.contexts?.trace) {
              spans.push({
                ...txPayload.contexts.trace,
                data: { ...txPayload.contexts.trace.data },
                transaction: txPayload.transaction,
              });
            }
            // Child spans
            if (Array.isArray(txPayload.spans)) {
              spans.push(...txPayload.spans);
            }
          }
        }
      }
      return spans;
    },

    getTransactions() {
      const txns: Record<string, unknown>[] = [];
      for (const env of envelopes) {
        for (const item of env.items) {
          // Note: In span streaming mode, transactions are not emitted
          // Spans come through with type: "span" instead
          if (
            typeof item.payload === "object" &&
            item.payload !== null &&
            (item.header.type === "transaction" || (item.payload as any).type === "transaction")
          ) {
            txns.push(item.payload as Record<string, unknown>);
          }
        }
      }
      return txns;
    },

    getErrorEvents() {
      const errors: Record<string, unknown>[] = [];
      for (const env of envelopes) {
        for (const item of env.items) {
          if (
            item.header.type === "event" &&
            typeof item.payload === "object" &&
            item.payload !== null
          ) {
            errors.push(item.payload as Record<string, unknown>);
          }
        }
      }
      return errors;
    },

    getSessions() {
      const sessions: Record<string, unknown>[] = [];
      for (const env of envelopes) {
        for (const item of env.items) {
          if (item.header.type === "session" && typeof item.payload === "object") {
            sessions.push(item.payload as Record<string, unknown>);
          }
        }
      }
      return sessions;
    },

    waitForEnvelopes(count: number, timeoutMs = 10_000) {
      if (envelopes.length >= count) {
        return Promise.resolve(envelopes);
      }
      return new Promise<Envelope[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${count} envelopes (got ${envelopes.length}) after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);

        waitResolvers.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve(envelopes);
          },
        });
      });
    },

    clear() {
      envelopes.length = 0;
    },

    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
