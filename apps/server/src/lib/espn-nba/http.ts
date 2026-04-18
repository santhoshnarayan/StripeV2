import { ProxyAgent, type Dispatcher } from "undici";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let cachedProxyAgent: Dispatcher | null | undefined;

function getProxyAgent(): Dispatcher | null {
  if (cachedProxyAgent !== undefined) return cachedProxyAgent;

  const server = process.env.SMARTPROXY_SERVER;
  const username = process.env.SMARTPROXY_USERNAME;
  const password = process.env.SMARTPROXY_PASSWORD;
  if (!server || !username || !password) {
    cachedProxyAgent = null;
    return null;
  }
  try {
    const parsed = new URL(server);
    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.hostname}:${parsed.port}`;
    cachedProxyAgent = new ProxyAgent(proxyUrl);
    console.log(
      `[espn-nba] Proxy agent ready (${parsed.hostname}:${parsed.port}); used only on retries.`,
    );
    return cachedProxyAgent;
  } catch (err) {
    console.error("[espn-nba] Failed to build proxy agent:", err);
    cachedProxyAgent = null;
    return null;
  }
}

export interface EspnRequestError extends Error {
  status?: number;
  url: string;
  attempts: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status: number): boolean {
  return status === 0 || status === 404 || status === 429 || status >= 500;
}

export async function espnFetch<T>(url: string): Promise<T> {
  let lastStatus = 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const viaProxy = attempt >= 2 && !!getProxyAgent();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const init: Parameters<typeof fetch>[1] = {
        headers: { accept: "*/*", "user-agent": USER_AGENT },
        signal: controller.signal,
      };
      if (viaProxy) {
        (init as { dispatcher?: Dispatcher }).dispatcher = getProxyAgent()!;
      }
      const res = await fetch(url, init);
      clearTimeout(timer);
      if (!res.ok) {
        lastStatus = res.status;
        const bodySnippet = await res
          .text()
          .then((t) => t.slice(0, 200))
          .catch(() => "");
        console.warn("[espn-nba]", {
          url,
          status: res.status,
          attempt,
          via: viaProxy ? "proxy" : "direct",
          msg: bodySnippet,
        });
        if (attempt < MAX_RETRIES && shouldRetry(res.status)) {
          await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        const err: EspnRequestError = Object.assign(
          new Error(`ESPN request failed: ${res.status} ${url}`),
          { status: res.status, url, attempts: attempt + 1 },
        );
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      if ((err as EspnRequestError).status !== undefined) throw err;
      lastError = err;
      lastStatus = 0;
      console.warn("[espn-nba]", {
        url,
        status: 0,
        attempt,
        via: viaProxy ? "proxy" : "direct",
        msg: (err as Error).message,
      });
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }

  console.error("[espn-nba] giving up", { url, lastStatus, lastError });
  const err: EspnRequestError = Object.assign(
    new Error(`ESPN request failed after retries: ${url}`),
    { status: lastStatus, url, attempts: MAX_RETRIES + 1 },
  );
  throw err;
}
