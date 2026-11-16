// The openclaw package ships these plugin SDK subpaths without type declarations.
// Only the helpers this plugin uses are declared, with signatures copied from
// OpenClaw 2026.11.3 (src/agents/tools/*, src/secrets/provider-credential-values.ts).

declare module "openclaw/plugin-sdk/provider-web-search" {
  export type SearchConfigRecord = Record<string, unknown> & {
    maxResults?: number;
    timeoutSeconds?: number;
    cacheTtlMinutes?: number;
  };
  export function readConfiguredSecretString(value: unknown, path: string): string | undefined;
  export function readProviderEnvValue(envVars: string[]): string | undefined;
  export function mergeScopedSearchConfig(
    searchConfig: Record<string, unknown> | undefined,
    key: string,
    pluginConfig: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined;
  export function resolveProviderWebSearchPluginConfig(
    config: unknown,
    pluginId: string,
  ): Record<string, unknown> | undefined;
  export function resolveSearchTimeoutSeconds(searchConfig?: SearchConfigRecord): number;
  export function resolveSearchCacheTtlMs(searchConfig?: SearchConfigRecord): number;
  export function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string;
  export function readCachedSearchPayload(
    cacheKey: string,
    ttlMs?: number,
  ): Record<string, unknown> | undefined;
  export function writeCachedSearchPayload(
    cacheKey: string,
    payload: Record<string, unknown>,
    ttlMs: number,
  ): void;
  export function resolveSiteName(url: string | undefined): string | undefined;
}

declare module "openclaw/plugin-sdk/provider-web-search-contract" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
  type WebSearchProviderPlugin = Parameters<OpenClawPluginApi["registerWebSearchProvider"]>[0];
  export function createWebSearchProviderContractFields(options: {
    credentialPath: string;
    inactiveSecretPaths?: string[];
    searchCredential: { type: "none" } | { type: "top-level" } | { type: "scoped"; scopeId: string };
    configuredCredential?: { pluginId: string; field?: string };
    selectionPluginId?: string;
  }): Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> &
    Partial<
      Pick<
        WebSearchProviderPlugin,
        "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
      >
    >;
}

declare module "openclaw/plugin-sdk/provider-web-fetch" {
  export function withStrictWebToolsEndpoint<T>(
    params: {
      url: string;
      init?: RequestInit;
      timeoutSeconds?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
    run: (result: { response: Response; finalUrl: string }) => Promise<T>,
  ): Promise<T>;
  export function markdownToText(markdown: string): string;
}

declare module "openclaw/plugin-sdk/provider-web-fetch-contract" {
  export function enablePluginInConfig<T>(config: T, pluginId: string): { enabled: boolean; config: T };
}
