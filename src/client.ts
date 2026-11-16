import { withStrictWebToolsEndpoint } from "openclaw/plugin-sdk/provider-web-fetch";
import { API_BASE_URL, sdkHeader } from "./constants.js";

const ERROR_DETAIL_MAX_CHARS = 300;
const SCRAPE_TIMEOUT_TITLE = "REQUEST_FAILED_SCRAPE_TIMEOUT";
const SYNC_SCRAPE_TIMEOUT_SECONDS = 60;
const POLL_INTERVAL_MS = 3_000;

type JsonRecord = Record<string, unknown>;

type ApiResponse = { status: number; body: JsonRecord | undefined };

type CallOptions = { timeoutSeconds: number; signal?: AbortSignal };

/** An error from the Web API. Its message never contains the API key. */
export class OxylabsApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = "OxylabsApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdOf(body: JsonRecord | undefined): string | undefined {
  const metadata = isRecord(body?.metadata) ? body.metadata : undefined;
  const id = metadata?.request_id ?? body?.request_id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function clip(text: string): string {
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

/** Turn a failed response into a message the agent (and the user) can act on. */
export function describeApiError(status: number, body: JsonRecord | undefined): string {
  const requestId = requestIdOf(body);
  const suffix = requestId ? ` (request_id ${requestId})` : "";
  if (status === 401) {
    return "Oxylabs Web API rejected the API key (401). Check OXYLABS_WEB_API_KEY or plugins.entries.oxylabs.config.webSearch.apiKey.";
  }
  if (status === 403) {
    return `Oxylabs Web API refused the request (403): the account has no access to this feature${suffix}.`;
  }
  if (status === 429 && body?.title === "QUOTA_EXCEEDED") {
    return "Oxylabs Web API quota is used up (429 QUOTA_EXCEEDED). Top up the plan in the Oxylabs dashboard.";
  }
  const title = typeof body?.title === "string" ? body.title : "request failed";
  const fieldErrors = Array.isArray(body?.errors)
    ? body.errors
        .filter(isRecord)
        .map((entry) => `${String(entry.pointer ?? "").replace(/^#\//, "")}: ${String(entry.detail ?? "")}`)
        .join("; ")
    : "";
  const detail = fieldErrors || (typeof body?.detail === "string" ? body.detail : "");
  return clip(`Oxylabs Web API error ${status} ${title}${detail ? `: ${detail}` : ""}`) + suffix;
}

async function call(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  body: JsonRecord | undefined,
  options: CallOptions,
): Promise<ApiResponse> {
  return await withStrictWebToolsEndpoint(
    {
      url: `${API_BASE_URL}${path}`,
      timeoutSeconds: options.timeoutSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
      init: {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-oxylabs-sdk": sdkHeader(),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    },
    async ({ response }) => {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: isRecord(parsed) ? parsed : undefined };
    },
  );
}

function ensureOk(response: ApiResponse): JsonRecord {
  if (response.status >= 200 && response.status < 300 && response.body) {
    return response.body;
  }
  throw new OxylabsApiError(
    describeApiError(response.status, response.body),
    response.status,
    requestIdOf(response.body),
  );
}

export type SearchParams = { query: string; count: number; location?: string };

export type SearchHit = { title: string; url: string; description: string; position?: number };

/** `POST /v1/search`: organic results with a short outline of each page. */
export async function searchWeb(
  apiKey: string,
  params: SearchParams,
  options: CallOptions,
): Promise<SearchHit[]> {
  const body: JsonRecord = { query: params.query, max_results: params.count };
  if (params.location) body.location = params.location;
  const data = ensureOk(await call("POST", "/v1/search", apiKey, body, options));
  const results = Array.isArray(data.results) ? data.results.filter(isRecord) : [];
  return results.map((entry) => {
    const outline = Array.isArray(entry.outline)
      ? entry.outline.filter((line): line is string => typeof line === "string")
      : [];
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    return {
      title: typeof entry.title === "string" ? entry.title : "",
      url: typeof entry.url === "string" ? entry.url : "",
      description: outline.join(" … "),
      ...(typeof metadata?.position === "number" ? { position: metadata.position } : {}),
    };
  });
}

export type ScrapeParams = { url: string; renderJs: boolean };

export type ScrapedPage = { markdown: string; status?: number; requestId?: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isClientTimeout(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const name = (error as { name?: string } | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function readPage(data: JsonRecord): ScrapedPage {
  const results = Array.isArray(data.results) ? data.results.filter(isRecord) : [];
  const first = results[0];
  const markdown = typeof first?.markdown === "string" ? first.markdown : "";
  const metadata = isRecord(first?.metadata) ? first.metadata : undefined;
  const statuses = isRecord(metadata?.statuses) ? metadata.statuses : undefined;
  const httpRequest = isRecord(statuses?.http_request) ? statuses.http_request : undefined;
  const requestId = requestIdOf(data);
  return {
    markdown,
    ...(typeof httpRequest?.code === "number" ? { status: httpRequest.code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * `POST /v1/scrape` for one page as Markdown.
 *
 * Most pages finish inside the synchronous call. When it times out, the same request is
 * queued on `/v1/async/scrape` and polled until `timeoutSeconds` runs out, instead of
 * being resent synchronously.
 */
export async function scrapePage(
  apiKey: string,
  params: ScrapeParams,
  options: CallOptions,
): Promise<ScrapedPage> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const body: JsonRecord = { url: params.url, output: ["markdown"] };
  if (params.renderJs) body.run_js = true;

  let timedOut = false;
  try {
    const response = await call("POST", "/v1/scrape", apiKey, body, {
      ...options,
      timeoutSeconds: Math.min(SYNC_SCRAPE_TIMEOUT_SECONDS, options.timeoutSeconds),
    });
    timedOut = response.status === 504 || response.body?.title === SCRAPE_TIMEOUT_TITLE;
    if (!timedOut) return readPage(ensureOk(response));
  } catch (error) {
    if (!isClientTimeout(error, options.signal)) throw error;
    timedOut = true;
  }

  const remaining = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  const queued = ensureOk(
    await call("POST", "/v1/async/scrape", apiKey, body, { ...options, timeoutSeconds: remaining() }),
  );
  const requestId = requestIdOf(queued);
  if (!requestId) {
    throw new OxylabsApiError("Oxylabs Web API queued the scrape but returned no request_id.", 502);
  }
  for (;;) {
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      throw new OxylabsApiError(
        `Oxylabs Web API did not finish scraping ${params.url} in time (request_id ${requestId}). Try again, or raise plugins.entries.oxylabs.config.webFetch.timeoutSeconds.`,
        504,
        requestId,
      );
    }
    await sleep(POLL_INTERVAL_MS, options.signal);
    const polled = await call("GET", `/v1/async/scrape/${requestId}`, apiKey, undefined, {
      ...options,
      timeoutSeconds: remaining(),
    });
    if (polled.body?.state === "pending") continue;
    return readPage(ensureOk(polled));
  }
}
