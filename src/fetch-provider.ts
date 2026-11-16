import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredSecretString, readProviderEnvValue } from "openclaw/plugin-sdk/provider-web-search";
import { markdownToText } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch-contract";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { scrapePage } from "./client.js";
import {
  API_KEY_ENV_VARS,
  DOCS_URL,
  FETCH_CREDENTIAL_PATH,
  PLUGIN_ID,
  PROVIDER_ID,
  SEARCH_CREDENTIAL_PATH,
  SIGNUP_URL,
} from "./constants.js";

export type WebFetchProviderPlugin = Parameters<OpenClawPluginApi["registerWebFetchProvider"]>[0];
type OpenClawConfig = NonNullable<Parameters<WebFetchProviderPlugin["createTool"]>[0]["config"]>;

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_SECONDS = 120;

type PluginConfig = {
  webSearch?: { apiKey?: unknown };
  webFetch?: { apiKey?: unknown; renderJs?: unknown; timeoutSeconds?: unknown };
};

function pluginConfig(config?: OpenClawConfig): PluginConfig | undefined {
  return config?.plugins?.entries?.[PLUGIN_ID]?.config as PluginConfig | undefined;
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

/** The fetch key, then the search key, then OXYLABS_WEB_API_KEY: one key serves both providers. */
export function resolveFetchApiKey(config?: OpenClawConfig): string | undefined {
  const own = pluginConfig(config);
  return (
    readConfiguredSecretString(own?.webFetch?.apiKey, FETCH_CREDENTIAL_PATH) ??
    readConfiguredSecretString(own?.webSearch?.apiKey, SEARCH_CREDENTIAL_PATH) ??
    readProviderEnvValue(API_KEY_ENV_VARS)
  );
}

/** Reject anything Oxylabs should not be asked to fetch: non-HTTP(S) URLs and private or internal hosts. */
export function checkTargetUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url must be an absolute http(s) URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `url must use http or https, not ${parsed.protocol}`;
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    return `url points at a private or internal host (${parsed.hostname}), which the Oxylabs Web API cannot reach.`;
  }
  return undefined;
}

function resolveTimeoutSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 10
    ? Math.min(Math.floor(value), 300)
    : DEFAULT_TIMEOUT_SECONDS;
}

function resolveMaxChars(value: unknown, cap: unknown): number {
  const asPositive = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
  return Math.floor(Math.min(asPositive(value) ?? DEFAULT_MAX_CHARS, asPositive(cap) ?? DEFAULT_MAX_CHARS));
}

export async function executeFetch(
  config: OpenClawConfig | undefined,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scrape: typeof scrapePage = scrapePage,
): Promise<Record<string, unknown>> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const urlProblem = checkTargetUrl(url);
  if (urlProblem) {
    return { error: "invalid_url", message: urlProblem, docs: DOCS_URL };
  }
  const apiKey = resolveFetchApiKey(config);
  if (!apiKey) {
    return {
      error: "missing_oxylabs_api_key",
      message: `web_fetch (oxylabs) needs an Oxylabs Web API key. Set OXYLABS_WEB_API_KEY in the Gateway environment, or configure ${FETCH_CREDENTIAL_PATH}.`,
      docs: DOCS_URL,
    };
  }
  const own = pluginConfig(config)?.webFetch;
  const extractMode = args.extractMode === "text" ? "text" : "markdown";
  const maxChars = resolveMaxChars(args.maxChars, config?.tools?.web?.fetch?.maxCharsCap);

  const page = await scrape(
    apiKey,
    { url, renderJs: own?.renderJs === true },
    { timeoutSeconds: resolveTimeoutSeconds(own?.timeoutSeconds), ...(signal ? { signal } : {}) },
  );
  signal?.throwIfAborted();
  if (page.status !== undefined && (page.status < 200 || page.status >= 300)) {
    throw new Error(`Oxylabs fetch failed: ${url} returned HTTP ${page.status}.`);
  }
  if (!page.markdown) {
    throw new Error(`Oxylabs fetch returned no content for ${url}.`);
  }

  const rawText = extractMode === "text" ? markdownToText(page.markdown) : page.markdown;
  const bounded = truncateSanitizedExternalContent(rawText, maxChars);
  const wrappedText = wrapExternalContent(bounded.text, { source: "web_fetch", includeWarning: false });
  return {
    url,
    finalUrl: url,
    ...(page.status !== undefined ? { status: page.status } : {}),
    extractor: PROVIDER_ID,
    extractMode,
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
    truncated: bounded.truncated,
    rawLength: rawText.length,
    length: wrappedText.length,
    text: wrappedText,
  };
}

export function createOxylabsWebFetchProvider(): WebFetchProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Oxylabs Web API",
    hint: "Fetch JavaScript-heavy and bot-protected pages as Markdown.",
    credentialLabel: "Oxylabs Web API key",
    envVars: API_KEY_ENV_VARS,
    placeholder: "your-web-api-key",
    signupUrl: SIGNUP_URL,
    docsUrl: DOCS_URL,
    autoDetectOrder: 70,
    credentialPath: FETCH_CREDENTIAL_PATH,
    inactiveSecretPaths: [FETCH_CREDENTIAL_PATH],
    getCredentialValue: (fetchConfig) => {
      const scoped = fetchConfig?.[PROVIDER_ID];
      return scoped && typeof scoped === "object" ? (scoped as { apiKey?: unknown }).apiKey : undefined;
    },
    setCredentialValue: (fetchConfigTarget, value) => {
      ensureRecord(fetchConfigTarget, PROVIDER_ID).apiKey = value;
    },
    getConfiguredCredentialValue: (config) => pluginConfig(config)?.webFetch?.apiKey,
    getConfiguredCredentialFallback: (config) => {
      const apiKey = pluginConfig(config)?.webSearch?.apiKey;
      return apiKey === undefined ? undefined : { path: SEARCH_CREDENTIAL_PATH, value: apiKey };
    },
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
      const entry = ensureRecord(ensureRecord(plugins, "entries"), PLUGIN_ID);
      ensureRecord(ensureRecord(entry, "config"), "webFetch").apiKey = value;
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, PLUGIN_ID).config,
    createTool: ({ config }) => ({
      description: "Fetch a page as Markdown or text with the Oxylabs Web API.",
      parameters: {},
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        return await executeFetch(config, args, context?.signal);
      },
    }),
  };
}
