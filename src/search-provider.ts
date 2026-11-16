import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildSearchCacheKey,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeCachedSearchPayload,
  type SearchConfigRecord,
} from "openclaw/plugin-sdk/provider-web-search";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";
import { wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { searchWeb } from "./client.js";
import {
  API_KEY_ENV_VARS,
  DEFAULT_SEARCH_COUNT,
  DOCS_URL,
  MAX_SEARCH_COUNT,
  PLUGIN_ID,
  PROVIDER_ID,
  SEARCH_CREDENTIAL_PATH,
  SIGNUP_URL,
} from "./constants.js";

export type WebSearchProviderPlugin = Parameters<OpenClawPluginApi["registerWebSearchProvider"]>[0];
type SearchContext = Parameters<WebSearchProviderPlugin["createTool"]>[0];

const SearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: `Number of results to return (1-${MAX_SEARCH_COUNT}).`,
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
    location: {
      type: "string",
      description:
        "Two-letter country code to search from, so results match what users there see (e.g. US, DE, JP).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A two-letter country code, upper-cased, or undefined when the value is not one. */
export function normalizeLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

export function resolveCount(value: unknown, fallback: unknown): number {
  for (const candidate of [value, fallback]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1) {
      return Math.min(candidate, MAX_SEARCH_COUNT);
    }
  }
  return DEFAULT_SEARCH_COUNT;
}

export async function executeSearch(
  ctx: SearchContext,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  search: typeof searchWeb = searchWeb,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    PROVIDER_ID,
    resolveProviderWebSearchPluginConfig(ctx.config, PLUGIN_ID),
  ) as SearchConfigRecord | undefined;
  const oxylabsConfig = isRecord(searchConfig?.[PROVIDER_ID]) ? searchConfig[PROVIDER_ID] : undefined;
  const apiKey =
    readConfiguredSecretString(oxylabsConfig?.apiKey, SEARCH_CREDENTIAL_PATH) ??
    readProviderEnvValue(API_KEY_ENV_VARS);
  if (!apiKey) {
    return {
      error: "missing_oxylabs_api_key",
      message: `web_search (oxylabs) needs an Oxylabs Web API key. Set OXYLABS_WEB_API_KEY in the Gateway environment, or configure ${SEARCH_CREDENTIAL_PATH}.`,
      docs: DOCS_URL,
    };
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { error: "missing_query", message: "query must be a non-empty string.", docs: DOCS_URL };
  }
  if (args.location !== undefined && !normalizeLocation(args.location)) {
    return {
      error: "invalid_location",
      message: "location must be a two-letter country code, e.g. US or DE.",
      docs: DOCS_URL,
    };
  }
  const location = normalizeLocation(args.location) ?? normalizeLocation(oxylabsConfig?.location);
  const count = resolveCount(args.count, searchConfig?.maxResults);

  const cacheKey = buildSearchCacheKey([
    PROVIDER_ID,
    createHash("sha256").update(apiKey).digest("hex"),
    query,
    count,
    location,
  ]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) return cached;

  const start = Date.now();
  const hits = await search(
    apiKey,
    { query, count, ...(location ? { location } : {}) },
    { timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig), ...(signal ? { signal } : {}) },
  );
  signal?.throwIfAborted();

  const payload = {
    query,
    provider: PROVIDER_ID,
    count: hits.length,
    tookMs: Date.now() - start,
    ...(location ? { location } : {}),
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: PROVIDER_ID,
      wrapped: true,
    },
    results: hits.map((hit) => ({
      title: hit.title ? wrapWebContent(hit.title, "web_search") : "",
      url: hit.url,
      description: hit.description ? wrapWebContent(hit.description, "web_search") : "",
      siteName: resolveSiteName(hit.url) || undefined,
    })),
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}

export function createOxylabsWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Oxylabs Web API",
    hint: "Geo-targeted Google results with page outlines",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Oxylabs Web API key",
    envVars: API_KEY_ENV_VARS,
    placeholder: "your-web-api-key",
    signupUrl: SIGNUP_URL,
    docsUrl: DOCS_URL,
    autoDetectOrder: 70,
    credentialPath: SEARCH_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SEARCH_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: PROVIDER_ID },
      configuredCredential: { pluginId: PLUGIN_ID },
      selectionPluginId: PLUGIN_ID,
    }),
    createTool: (ctx) => ({
      description:
        "Search the web with the Oxylabs Web API. Returns titles, URLs and a short outline of each page. Pass location (two-letter country code) to get results as seen from that country.",
      parameters: SearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        return await executeSearch(ctx, args, context?.signal);
      },
    }),
  };
}
