import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID } from "./src/constants.js";
import { createOxylabsWebFetchProvider } from "./src/fetch-provider.js";
import { createOxylabsWebSearchProvider } from "./src/search-provider.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Oxylabs Web API",
  description: "web_search and web_fetch providers powered by the Oxylabs Web API",
  register(api) {
    api.registerWebSearchProvider(createOxylabsWebSearchProvider());
    api.registerWebFetchProvider(createOxylabsWebFetchProvider());
  },
});
