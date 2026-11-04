import { z } from 'zod';

export class CdpError extends Error {
  override name = 'CdpError';
}

export interface CdpOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

const targetsSchema = z.array(
  z.object({
    type: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  }),
);

const replySchema = z.object({
  id: z.number().optional(),
  error: z.object({ message: z.string() }).optional(),
  result: z
    .object({
      result: z.object({ value: z.unknown().optional() }).optional(),
      exceptionDetails: z.unknown().optional(),
    })
    .optional(),
});

async function findChartSocket({ host, port, timeoutMs = 10_000 }: CdpOptions): Promise<string> {
  let targets: z.infer<typeof targetsSchema>;
  try {
    const response = await fetch(`http://${host}:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    targets = targetsSchema.parse(await response.json());
  } catch {
    throw new CdpError(
      `TradingView is not reachable on ${host}:${port}. Start it with --remote-debugging-port=${port}.`,
    );
  }

  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  const chart =
    pages.find((target) => /tradingview\.com\/chart/i.test(target.url)) ??
    pages.find((target) => /tradingview/i.test(target.url));
  if (!chart?.webSocketDebuggerUrl) {
    throw new CdpError('no TradingView chart tab is open');
  }
  return chart.webSocketDebuggerUrl;
}

/**
 * Evaluates a JavaScript expression in the TradingView chart tab over the Chrome DevTools
 * Protocol and returns its value. One short-lived connection per call keeps this robust against
 * TradingView restarts.
 */
export async function evaluateInChart(options: CdpOptions, expression: string): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const socketUrl = await findChartSocket(options);

  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let settled = false;
    const timer = setTimeout(
      () => finish(new CdpError(`TradingView did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );

    function finish(error?: Error, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (error) reject(error);
      else resolve(value);
    }

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      let reply: z.infer<typeof replySchema>;
      try {
        reply = replySchema.parse(JSON.parse(String(event.data)));
      } catch {
        return; // an event we did not ask for
      }
      if (reply.id !== 1) return;
      if (reply.error) return finish(new CdpError(`DevTools error: ${reply.error.message}`));
      if (reply.result?.exceptionDetails) return finish(new CdpError('the page script threw'));
      finish(undefined, reply.result?.result?.value);
    });
    socket.addEventListener('error', () => finish(new CdpError('could not talk to TradingView')));
    socket.addEventListener('close', () =>
      finish(new CdpError('TradingView closed the connection before answering')),
    );
  });
}
