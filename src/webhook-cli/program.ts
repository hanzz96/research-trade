import { Command, InvalidArgumentError, Option } from 'commander';
import { DiscordNotifier } from '../shared/discord.js';
import { checkHealth, sendBars, sendSignal, type FetchLike, type HttpResult } from './client.js';

/** Everything the CLI touches outside itself, so tests can run it without a terminal or a network. */
export interface CliDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  print: (line: string) => void;
  printError: (line: string) => void;
  /** Called when a command fails; the real one sets the process exit code to 1. */
  fail: () => void;
  /** Tests only: make commander throw instead of exiting, and send its own output here. */
  commanderOutput?: { writeOut: (text: string) => void; writeErr: (text: string) => void };
}

const MIN_PRICE = 100;

function atLeast(min: number) {
  return (value: string): number => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min) throw new InvalidArgumentError(`must be a number of at least ${min}`);
    return number;
  };
}

function wholeNumber(min: number, max: number) {
  return (value: string): number => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new InvalidArgumentError(`must be a whole number from ${min} to ${max}`);
    }
    return number;
  };
}

function minutesDividingHour(value: string): string {
  if (!/^\d+$/.test(value) || 60 % Number(value) !== 0) {
    throw new InvalidArgumentError('must be a number of minutes that divides 60 (for example 15 or 30)');
  }
  return value;
}

/** Keeps only the origin, so credentials typed into a URL are never echoed back. */
function serverUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // falls through to the error below
  }
  throw new InvalidArgumentError('must be an http(s) URL such as http://127.0.0.1:3000');
}

const HINTS: Record<number, string> = {
  400: 'the server rejected the request: see "reason" in the body (for example an unsupported timeframe or a stale candle)',
  401: 'the token does not match the one the server was started with',
  404: 'the route does not exist (for /ingest/bars the server needs INGEST_TOKEN)',
  429: 'rate limited: wait a minute',
};

const isNetworkError = (err: unknown) =>
  err instanceof Error &&
  (err.name === 'TimeoutError' || (err.name === 'TypeError' && err.message === 'fetch failed'));

/**
 * Command line to try the webhooks by hand, with the secrets taken from the environment (`.env`).
 * Tokens and the Discord URL are never printed and never shown as option defaults.
 */
export function buildProgram(deps: CliDeps): Command {
  const { env } = deps;

  const program = new Command()
    .name('webhook')
    .description('Try the webhooks of this project by hand')
    .showHelpAfterError();
  if (deps.commanderOutput) program.exitOverride().configureOutput(deps.commanderOutput);

  const defaultBaseUrl = () => {
    const host = !env.HOST || env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST;
    return `http://${host}:${env.PORT ?? '3000'}`;
  };
  const firstOf = (list: string | undefined, fallback: string) => list?.split(',')[0]?.trim() || fallback;
  const requireSecret = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`${name} is not set: put it in .env or pass it as an option`);
    return value;
  };

  function show(label: string, result: HttpResult): void {
    deps.print(`${label}HTTP ${result.status} ${JSON.stringify(result.body)}`);
    const hint = HINTS[result.status];
    if (!result.ok && hint) deps.print(`  hint: ${hint}`);
    if (!result.ok) deps.fail();
  }

  /** Runs a command and turns a thrown error into a short message and a failed exit. */
  async function run(baseUrl: string | undefined, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      if (baseUrl && isNetworkError(err)) {
        deps.printError(`could not reach ${baseUrl}: is the server running (npm run dev)?`);
      } else {
        deps.printError(err instanceof Error ? err.message : String(err));
      }
      deps.fail();
    }
  }

  const urlOption = '-u, --url <url>';
  const urlHelp = 'base URL of the server (default: from HOST and PORT in .env)';

  program
    .command('signal')
    .description('send a TradingView-style signal to POST /webhook/tradingview')
    .addOption(new Option('-d, --direction <direction>', 'signal direction').choices(['BUY', 'SELL']).default('BUY'))
    .option(urlOption, urlHelp, serverUrl)
    .option('-t, --token <token>', 'shared webhook token (default: WEBHOOK_TOKEN in .env)')
    .option('-s, --symbol <symbol>', 'symbol (default: first of ALLOWED_SYMBOLS, else XAUUSD)')
    .option('-f, --timeframe <minutes>', 'timeframe (default: first of ALLOWED_TIMEFRAMES, else 15)')
    .option('-p, --price <price>', 'price of the signal', atLeast(MIN_PRICE), 3985.25)
    .option('-a, --age-minutes <minutes>', 'how long ago the candle opened', wholeNumber(0, 24 * 60), 5)
    .option('--no-plan', 'leave out the indicative stop and target')
    .option('--twice', 'send the same signal twice, to see the duplicate answer')
    .action(async (options) => {
      const baseUrl: string = options.url ?? defaultBaseUrl();
      await run(baseUrl, async () => {
        const results = await sendSignal(
          {
            baseUrl,
            token: requireSecret(options.token ?? env.WEBHOOK_TOKEN, 'WEBHOOK_TOKEN'),
            symbol: options.symbol ?? firstOf(env.ALLOWED_SYMBOLS, 'XAUUSD'),
            timeframe: options.timeframe ?? firstOf(env.ALLOWED_TIMEFRAMES, '15'),
            direction: options.direction,
            price: options.price,
            ageMinutes: options.ageMinutes,
            plan: options.plan,
            twice: Boolean(options.twice),
          },
          deps.fetch,
        );
        results.forEach((result, index) => show(results.length > 1 ? `#${index + 1} ` : '', result));
        if (results[0]?.ok) deps.print('A Discord message should follow within a few seconds.');
      });
    });

  program
    .command('bars')
    .description('send closed candles to POST /ingest/bars (forward test data)')
    .option(urlOption, urlHelp, serverUrl)
    .option('-t, --token <token>', 'ingest token (default: INGEST_TOKEN in .env)')
    .option('-s, --symbol <symbol>', 'symbol (default: first of ALLOWED_SYMBOLS, else XAUUSD)')
    .option('-f, --timeframe <minutes>', 'candle length in minutes', minutesDividingHour, '15')
    .option('-n, --count <count>', 'how many closed candles to send', wholeNumber(1, 500), 1)
    .option('-p, --price <price>', 'price around which the candles are drawn', atLeast(MIN_PRICE), 3985.25)
    .action(async (options) => {
      const baseUrl: string = options.url ?? defaultBaseUrl();
      await run(baseUrl, async () => {
        const result = await sendBars(
          {
            baseUrl,
            token: requireSecret(options.token ?? env.INGEST_TOKEN, 'INGEST_TOKEN'),
            source: 'webhook-cli',
            symbol: options.symbol ?? firstOf(env.ALLOWED_SYMBOLS, 'XAUUSD'),
            timeframe: options.timeframe,
            count: options.count,
            price: options.price,
          },
          deps.fetch,
        );
        show('', result);
        if (result.ok) {
          deps.print('These candles are synthetic (source "webhook-cli") and now sit in the bars table.');
          deps.print("  remove them with: DELETE FROM bars WHERE source = 'webhook-cli';");
        }
      });
    });

  program
    .command('discord')
    .description('post a test message straight to the Discord webhook (DISCORD_WEBHOOK_URL in .env)')
    .option('-m, --message <text>', 'message to send', 'Tes webhook Discord dari research-trade.')
    .action(async (options) => {
      await run(undefined, async () => {
        const url = requireSecret(env.DISCORD_WEBHOOK_URL, 'DISCORD_WEBHOOK_URL');
        await new DiscordNotifier(url, deps.fetch).send(options.message);
        deps.print('Discord accepted the message.');
      });
    });

  program
    .command('health')
    .description('GET /health: is the server up, and the latest stored candles')
    .option(urlOption, urlHelp, serverUrl)
    .action(async (options) => {
      const baseUrl: string = options.url ?? defaultBaseUrl();
      await run(baseUrl, async () => show('', await checkHealth(baseUrl, deps.fetch)));
    });

  return program;
}
