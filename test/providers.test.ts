import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { describeApiError, type ScrapedPage, type SearchHit } from "../src/client.js";
import { sdkHeader, VERSION } from "../src/constants.js";
import {
  checkTargetUrl,
  createOxylabsWebFetchProvider,
  executeFetch,
  resolveFetchApiKey,
} from "../src/fetch-provider.js";
import {
  createOxylabsWebSearchProvider,
  executeSearch,
  normalizeLocation,
  resolveCount,
} from "../src/search-provider.js";

// Tests run from the compiled .test-build/ directory; npm runs them from the repo root.
const readRootJson = (name: string) => JSON.parse(readFileSync(join(process.cwd(), name), "utf8"));

function configWith(pluginConfig: Record<string, unknown>) {
  return { plugins: { entries: { oxylabs: { enabled: true, config: pluginConfig } } } } as never;
}

function fakeSearch(hits: SearchHit[]) {
  const calls: unknown[][] = [];
  const search = async (...args: unknown[]) => {
    calls.push(args);
    return hits;
  };
  return { calls, search: search as never };
}

function fakeScrape(page: ScrapedPage) {
  const calls: unknown[][] = [];
  const scrape = async (...args: unknown[]) => {
    calls.push(args);
    return page;
  };
  return { calls, scrape: scrape as never };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.OXYLABS_WEB_API_KEY;
  delete process.env.OXYLABS_WEB_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OXYLABS_WEB_API_KEY;
  else process.env.OXYLABS_WEB_API_KEY = savedKey;
});

describe("constants", () => {
  it("keeps VERSION in step with package.json", () => {
    assert.equal(VERSION, readRootJson("package.json").version);
  });

  it("sends an x-oxylabs-sdk value the Oxylabs allowlists accept", () => {
    assert.match(sdkHeader(), /^oxylabs-web-api-openclaw\/\d+\.\d+\.\d+ \(openclaw; node [\d.]+\)$/);
  });

  it("declares the same provider ids in the manifest as at runtime", () => {
    const manifest = readRootJson("openclaw.plugin.json");
    assert.deepEqual(manifest.contracts.webSearchProviders, [createOxylabsWebSearchProvider().id]);
    assert.deepEqual(manifest.contracts.webFetchProviders, [createOxylabsWebFetchProvider().id]);
  });
});

describe("describeApiError", () => {
  it("explains a rejected key", () => {
    assert.match(describeApiError(401, undefined), /rejected the API key/);
  });

  it("lists field errors and the request id", () => {
    const message = describeApiError(400, {
      title: "VALIDATION_ERROR",
      detail: "1 request field is invalid",
      errors: [{ pointer: "#/max_results", detail: "Input should be less than or equal to 20" }],
      metadata: { request_id: "123" },
    });
    assert.equal(
      message,
      "Oxylabs Web API error 400 VALIDATION_ERROR: max_results: Input should be less than or equal to 20 (request_id 123)",
    );
  });

  it("names a spent quota", () => {
    assert.match(describeApiError(429, { title: "QUOTA_EXCEEDED" }), /quota is used up/);
  });
});

describe("search", () => {
  it("normalises locations and counts", () => {
    assert.equal(normalizeLocation(" de "), "DE");
    assert.equal(normalizeLocation("Germany"), undefined);
    assert.equal(resolveCount(50, undefined), 20);
    assert.equal(resolveCount(undefined, 8), 8);
    assert.equal(resolveCount("x", undefined), 5);
  });

  it("asks for a key when none is configured", async () => {
    const fake = fakeSearch([]);
    const result = await executeSearch({ config: configWith({}) }, { query: "q" }, undefined, fake.search);
    assert.equal(result.error, "missing_oxylabs_api_key");
    assert.equal(fake.calls.length, 0);
  });

  it("rejects a location that is not a country code", async () => {
    process.env.OXYLABS_WEB_API_KEY = "env-key";
    const fake = fakeSearch([]);
    const result = await executeSearch(
      { config: configWith({}) },
      { query: "q", location: "Germany" },
      undefined,
      fake.search,
    );
    assert.equal(result.error, "invalid_location");
  });

  it("uses the configured key and default location, and wraps results as untrusted", async () => {
    const fake = fakeSearch([
      { title: "Example", url: "https://example.com/a", description: "first … second", position: 1 },
    ]);
    const result = await executeSearch(
      { config: configWith({ webSearch: { apiKey: "config-key", location: "us" } }) },
      { query: "unique query for wrapping test", count: 3 },
      undefined,
      fake.search,
    );
    assert.equal(fake.calls[0]?.[0], "config-key");
    assert.deepEqual(fake.calls[0]?.[1], { query: "unique query for wrapping test", count: 3, location: "US" });
    assert.equal(result.provider, "oxylabs");
    assert.deepEqual(result.externalContent, {
      untrusted: true,
      source: "web_search",
      provider: "oxylabs",
      wrapped: true,
    });
    const [hit] = result.results as Array<Record<string, string>>;
    assert.equal(hit?.url, "https://example.com/a");
    assert.equal(hit?.siteName, "example.com");
    const title = hit?.title ?? "";
    assert.ok(title.includes("Example") && title !== "Example", "title is wrapped");
  });

  it("serves a repeated query from the cache", async () => {
    process.env.OXYLABS_WEB_API_KEY = "env-key";
    const fake = fakeSearch([]);
    const ctx = { config: configWith({}) };
    await executeSearch(ctx, { query: "cached query" }, undefined, fake.search);
    const second = await executeSearch(ctx, { query: "cached query" }, undefined, fake.search);
    assert.equal(fake.calls.length, 1);
    assert.equal(second.cached, true);
  });
});

describe("fetch", () => {
  it("refuses private, internal and non-HTTP targets", () => {
    assert.equal(checkTargetUrl("https://example.com/page"), undefined);
    assert.match(checkTargetUrl("http://127.0.0.1:8080/") ?? "", /private or internal/);
    assert.match(checkTargetUrl("http://localhost/") ?? "", /private or internal/);
    assert.match(checkTargetUrl("file:///etc/passwd") ?? "", /http or https/);
    assert.match(checkTargetUrl("not a url") ?? "", /absolute/);
  });

  it("falls back from the fetch key to the search key to the env var", () => {
    assert.equal(resolveFetchApiKey(configWith({ webFetch: { apiKey: "f" }, webSearch: { apiKey: "s" } })), "f");
    assert.equal(resolveFetchApiKey(configWith({ webSearch: { apiKey: "s" } })), "s");
    process.env.OXYLABS_WEB_API_KEY = "env-key";
    assert.equal(resolveFetchApiKey(configWith({})), "env-key");
  });

  it("returns wrapped, truncated text", async () => {
    const fake = fakeScrape({ markdown: "# Title\n\nSome **bold** text.", status: 200 });
    const result = await executeFetch(
      configWith({ webSearch: { apiKey: "k" }, webFetch: { renderJs: true } }),
      { url: "https://example.com", extractMode: "text", maxChars: 12 },
      undefined,
      fake.scrape,
    );
    assert.equal(fake.calls[0]?.[0], "k");
    assert.deepEqual(fake.calls[0]?.[1], { url: "https://example.com", renderJs: true });
    assert.equal((fake.calls[0]?.[2] as { timeoutSeconds: number }).timeoutSeconds, 120);
    assert.equal(result.extractor, "oxylabs");
    assert.equal(result.extractMode, "text");
    assert.equal(result.status, 200);
    assert.equal(result.truncated, true);
    assert.ok(!String(result.text).includes("**"));
  });

  it("reports a target page that answered with an error status", async () => {
    const fake = fakeScrape({ markdown: "Not found", status: 404 });
    await assert.rejects(
      executeFetch(
        configWith({ webSearch: { apiKey: "k" } }),
        { url: "https://example.com/missing" },
        undefined,
        fake.scrape,
      ),
      /returned HTTP 404/,
    );
  });
});
