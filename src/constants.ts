export const PLUGIN_ID = "oxylabs";
export const PROVIDER_ID = "oxylabs";
// Kept in step with package.json by test/constants.test.ts.
export const VERSION = "0.1.1";

export const API_BASE_URL = "https://webapi.oxylabs.io";
export const API_KEY_ENV_VARS = ["OXYLABS_WEB_API_KEY"];
export const SIGNUP_URL = "https://dashboard.oxylabs.io/";
export const DOCS_URL = "https://github.com/oxylabs/openclaw-oxylabs-web-api#readme";

export const SEARCH_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;
export const FETCH_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webFetch.apiKey`;

/** The Web API's own limit on `max_results`. */
export const MAX_SEARCH_COUNT = 20;
export const DEFAULT_SEARCH_COUNT = 5;

/** Value of the `x-oxylabs-sdk` header, which Oxylabs uses to count requests per integration. */
export function sdkHeader(): string {
  return `oxylabs-web-api-openclaw/${VERSION} (openclaw; node ${process.versions.node})`;
}
