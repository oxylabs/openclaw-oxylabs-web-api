# Changelog

## 0.1.1

- README: installing from npm needs `--force` (OpenClaw asks for it on any plugin from outside ClawHub).
- First release published through the GitHub Actions workflow with npm provenance.

## 0.1.0

- First release: `oxylabs` web_search provider (`POST /v1/search`, optional country targeting) and web_fetch provider (`POST /v1/scrape` as Markdown, optional JavaScript rendering, falls back to the asynchronous endpoint when a page is slow).
