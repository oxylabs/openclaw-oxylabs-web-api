// Calls the real Oxylabs Web API through the built providers (run `npm run build` first).
// Needs OXYLABS_WEB_API_KEY in the environment or in .env. Prints results, never the key.
import assert from "node:assert/strict";
import { executeFetch } from "../dist/src/fetch-provider.js";
import { executeSearch } from "../dist/src/search-provider.js";

if (!process.env.OXYLABS_WEB_API_KEY) {
  console.error("Set OXYLABS_WEB_API_KEY first.");
  process.exit(1);
}
const config = { plugins: { entries: { oxylabs: { enabled: true, config: {} } } } };

const search = await executeSearch({ config }, { query: "oxylabs web api", count: 3, location: "DE" });
assert.equal(search.error, undefined, search.message);
assert.ok(search.results.length > 0, "search returned no results");
console.log(`search: ${search.count} results in ${search.tookMs} ms, first ${search.results[0].url}`);

const page = await executeFetch(config, { url: "https://example.com", extractMode: "markdown" });
assert.equal(page.status, 200);
assert.match(page.text, /documentation examples/);
console.log(`fetch: ${page.rawLength} chars from ${page.url}`);

const badKey = { plugins: { entries: { oxylabs: { config: { webSearch: { apiKey: "not-a-real-key" } } } } } };
await assert.rejects(
  executeSearch({ config: badKey }, { query: "rejected key check" }),
  /rejected the API key \(401\)/,
);
console.log("bad key: rejected with a clear 401 message");
