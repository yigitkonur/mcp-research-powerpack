MCP server that gives your AI assistant research tools. Google search, Reddit deep-dives, web scraping with LLM extraction, and multi-model deep research — all as MCP tools that chain into each other.

```bash
npx mcp-research-powerpack
```

five tools, zero config to start. each API key you add unlocks more capabilities.

[![npm](https://img.shields.io/npm/v/mcp-research-powerpack.svg?style=flat-square)](https://www.npmjs.com/package/mcp-research-powerpack)
[![node](https://img.shields.io/badge/node-20+-93450a.svg?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-grey.svg?style=flat-square)](https://opensource.org/licenses/MIT)

---

## tools

| tool | what it does | requires |
|:---|:---|:---|
| `web_search` | parallel Google search across 3-100 keywords, CTR-weighted ranking, consensus detection | `SERPER_API_KEY` |
| `search_reddit` | same engine but filtered to reddit.com, 10-50 queries in parallel | `SERPER_API_KEY` |
| `get_reddit_post` | fetches 2-50 Reddit posts with full comment trees, optional LLM extraction | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| `scrape_links` | scrapes 1-50 URLs with JS rendering fallback, HTML-to-markdown, optional LLM extraction | `SCRAPEDO_API_KEY` |
| `deep_research` | sends questions to research-capable models (Grok, Gemini) with web search enabled, supports local file attachments | `OPENROUTER_API_KEY` |

tools are designed to chain: `web_search` suggests calling `scrape_links`, which suggests `search_reddit`, which suggests `get_reddit_post`, which suggests `deep_research` for synthesis.

## install

### Claude Desktop / Claude Code

add to your MCP config:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["mcp-research-powerpack"],
      "env": {
        "SERPER_API_KEY": "...",
        "OPENROUTER_API_KEY": "..."
      }
    }
  }
}
```

### from source

```bash
git clone https://github.com/yigitkonur/mcp-research-powerpack.git
cd mcp-research-powerpack
pnpm install && pnpm build
pnpm start
```

### HTTP mode

```bash
MCP_TRANSPORT=http MCP_PORT=3000 npx mcp-research-powerpack
```

exposes `/mcp` (POST/GET/DELETE with session headers) and `/health`.

## API keys

each key unlocks a capability. missing keys silently disable their tools — the server never crashes.

| variable | enables | free tier |
|:---|:---|:---|
| `SERPER_API_KEY` | `web_search`, `search_reddit` | 2,500 searches/mo at serper.dev |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get_reddit_post` | unlimited (reddit.com/prefs/apps, "script" type) |
| `SCRAPEDO_API_KEY` | `scrape_links` | 1,000 credits/mo at scrape.do |
| `OPENROUTER_API_KEY` | `deep_research`, LLM extraction in scrape/reddit | pay-per-token at openrouter.ai |

## configuration

optional tuning via environment variables:

| variable | default | description |
|:---|:---|:---|
| `RESEARCH_MODEL` | `x-ai/grok-4-fast` | primary deep research model |
| `RESEARCH_FALLBACK_MODEL` | `google/gemini-2.5-flash` | fallback if primary fails |
| `LLM_EXTRACTION_MODEL` | `openai/gpt-oss-120b:nitro` | default model for scrape/reddit LLM extraction (can be overridden per-request via the `model` parameter in `scrape_links`) |
| `DEFAULT_REASONING_EFFORT` | `high` | research depth (`low`, `medium`, `high`) |
| `DEFAULT_MAX_URLS` | `100` | max search results per research question (10-200) |
| `API_TIMEOUT_MS` | `1800000` | request timeout in ms (default 30 min) |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3000` | port for HTTP mode |

## how it works

### search ranking

results from multiple queries are deduplicated by normalized URL and scored using CTR-weighted position values (position 1 = 100.0, position 10 = 12.56). URLs appearing across multiple queries get a consensus marker. threshold tries >= 3, falls back to >= 2, then >= 1.

### Reddit comment budget

global budget of 1,000 comments, max 200 per post. after the first pass, surplus from posts with fewer comments is redistributed to truncated posts in a second fetch pass.

### scraping pipeline

three-mode fallback per URL: basic → JS rendering → JS + US geo-targeting. results go through HTML-to-markdown conversion (turndown), then optional LLM extraction with a 100k char input cap and 8,000 token output per URL. the extraction model defaults to `openai/gpt-oss-120b:nitro` (configurable via `LLM_EXTRACTION_MODEL` env var) and can be overridden per-request using the `model` parameter.

### deep research

32,000 token budget divided across questions (1 question = 32k, 10 questions = 3.2k each). Gemini models get `google_search` tool access. Grok/Perplexity get `search_parameters` with citations. primary model fails → automatic fallback.

### file attachments

`deep_research` can read local files and include them as context. files over 600 lines are smart-truncated (first 500 + last 100 lines). line numbers preserved.

## concurrency

| operation | parallel limit |
|:---|:---|
| web search keywords | 8 |
| Reddit search queries | 8 |
| Reddit post fetches per batch | 5 (batches of 10) |
| URL scraping per batch | 10 (batches of 30) |
| LLM extraction | 3 |
| deep research questions | 3 |

all clients use manual retry with exponential backoff and jitter. the OpenAI SDK's built-in retry is disabled (`maxRetries: 0`).

## project structure

```
src/
  index.ts                — entry point, STDIO + HTTP transport, signal handling
  worker.ts               — Cloudflare Workers entry (Durable Objects)
  config/
    index.ts              — env parsing (lazy Proxy objects), capability detection
    loader.ts             — YAML → Zod → JSON Schema pipeline, cached
    yaml/tools.yaml       — single source of truth for all tool definitions
  schemas/
    deep-research.ts      — Zod validation for research questions + file attachments
    scrape-links.ts       — Zod validation for URLs, timeout, LLM options
    web-search.ts         — Zod validation for keyword arrays
  tools/
    registry.ts           — tool lookup → capability check → validate → execute
    search.ts             — web_search handler
    reddit.ts             — search_reddit + get_reddit_post handlers
    scrape.ts             — scrape_links handler
    research.ts           — deep_research handler
  clients/
    search.ts             — Serper API client
    reddit.ts             — Reddit OAuth + comment fetching
    scraper.ts            — scrape.do client with fallback modes
    research.ts           — OpenRouter client with model-specific handling
  services/
    llm-processor.ts      — shared LLM extraction (singleton OpenAI client)
    markdown-cleaner.ts   — HTML → markdown via turndown
    file-attachment.ts    — local file reading with line ranges
  utils/
    concurrency.ts        — bounded parallel execution (pMap, pMapSettled)
    url-aggregator.ts     — CTR-weighted scoring and consensus detection
    errors.ts             — error classification, fetchWithTimeout
    logger.ts             — MCP logging protocol
    response.ts           — standardized output formatting
```

## deploy

### Cloudflare Workers

```bash
npx wrangler deploy
```

uses Durable Objects with SQLite storage. YAML-based tool definitions are replaced with inline definitions in the worker entry since there's no filesystem.

## license

MIT
