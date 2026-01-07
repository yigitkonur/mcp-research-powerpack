<h1 align="center">🔬 Research Powerpack MCP 🔬</h1>
<h3 align="center">Stop tab-hopping for research. Start getting god-tier context.</h3>

<p align="center">
  <strong>
    <em>The ultimate research toolkit for your AI coding assistant. It searches the web, mines Reddit, scrapes any URL, and synthesizes everything into perfectly structured context your LLM actually understands.</em>
  </strong>
</p>

<p align="center">
  <!-- Package Info -->
  <a href="https://www.npmjs.com/package/research-powerpack-mcp"><img alt="npm" src="https://img.shields.io/npm/v/research-powerpack-mcp.svg?style=flat-square&color=4D87E6"></a>
  <a href="#"><img alt="node" src="https://img.shields.io/badge/node-18+-4D87E6.svg?style=flat-square"></a>
  &nbsp;&nbsp;•&nbsp;&nbsp;
  <!-- Features -->
  <a href="https://opensource.org/licenses/MIT"><img alt="license" src="https://img.shields.io/badge/License-MIT-F9A825.svg?style=flat-square"></a>
  <a href="#"><img alt="platform" src="https://img.shields.io/badge/platform-macOS_|_Linux_|_Windows-2ED573.svg?style=flat-square"></a>
</p>

<p align="center">
  <img alt="modular" src="https://img.shields.io/badge/🧩_modular-use_1_tool_or_all_5-2ED573.svg?style=for-the-badge">
  <img alt="zero crash" src="https://img.shields.io/badge/💪_zero_crash-missing_keys_=_helpful_errors-2ED573.svg?style=for-the-badge">
</p>

<div align="center">

### 🧭 Quick Navigation

[**⚡ Get Started**](#-get-started-in-60-seconds) •
[**✨ Key Features**](#-feature-breakdown-the-secret-sauce) •
[**🎮 Usage & Examples**](#-tool-reference) •
[**⚙️ API Key Setup**](#-api-key-setup-guides) •
[**🆚 Why This Slaps**](#-why-this-slaps-other-methods)

</div>

---

**`research-powerpack-mcp`** is the research assistant your AI wishes it had. Stop asking your LLM to guess about things it doesn't know. This MCP server acts like a senior researcher, searching the web, mining Reddit discussions, scraping documentation, and synthesizing everything into perfectly structured context so your AI can actually give you answers worth a damn.

<div align="center">
<table>
<tr>
<td align="center">
<h3>🔍</h3>
<b>Batch Web Search</b><br/>
<sub>100 keywords in parallel</sub>
</td>
<td align="center">
<h3>💬</h3>
<b>Reddit Mining</b><br/>
<sub>Real opinions, not marketing</sub>
</td>
<td align="center">
<h3>🌐</h3>
<b>Universal Scraping</b><br/>
<sub>JS rendering + geo-targeting</sub>
</td>
<td align="center">
<h3>🧠</h3>
<b>Deep Research</b><br/>
<sub>AI synthesis with citations</sub>
</td>
</tr>
</table>
</div>

How it slaps:
- **You:** "What's the best database for my use case?"
- **AI + Powerpack:** Searches Google, mines Reddit threads, scrapes docs, synthesizes findings.
- **You:** Get an actually informed answer with real community opinions and citations.
- **Result:** Ship better decisions. Skip the 47 browser tabs.

---

## 💥 Why This Slaps Other Methods

Manually researching is a vibe-killer. `research-powerpack-mcp` makes other methods look ancient.

<table align="center">
<tr>
<td align="center"><b>❌ The Old Way (Pain)</b></td>
<td align="center"><b>✅ The Powerpack Way (Glory)</b></td>
</tr>
<tr>
<td>
<ol>
  <li>Open 15 browser tabs.</li>
  <li>Skim Stack Overflow answers from 2019.</li>
  <li>Search Reddit, get distracted by drama.</li>
  <li>Copy-paste random snippets to your AI.</li>
  <li>Get a mediocre answer from confused context.</li>
</ol>
</td>
<td>
<ol>
  <li>Ask your AI to research it.</li>
  <li>AI searches, scrapes, mines Reddit automatically.</li>
  <li>Receive synthesized insights with sources.</li>
  <li>Make an informed decision.</li>
  <li>Go grab a coffee. ☕</li>
</ol>
</td>
</tr>
</table>

We're not just fetching random pages. We're building **high-signal, low-noise context** with CTR-weighted ranking, smart comment allocation, and intelligent token distribution that prevents massive responses from breaking your LLM's context window.

---

## 🚀 Get Started in 60 Seconds

### 1. Install

```bash
npm install research-powerpack-mcp
```

### 2. Configure Your MCP Client

<div align="center">

| Client | Config File | Docs |
|:------:|:-----------:|:----:|
| 🖥️ **Claude Desktop** | `claude_desktop_config.json` | [Setup](#claude-desktop) |
| ⌨️ **Claude Code** | `~/.claude.json` or CLI | [Setup](#claude-code-cli) |
| 🎯 **Cursor** | `.cursor/mcp.json` | [Setup](#cursorwindsurf) |
| 🏄 **Windsurf** | MCP settings | [Setup](#cursorwindsurf) |

</div>

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["research-powerpack-mcp"],
      "env": {
        "SERPER_API_KEY": "your_key",
        "REDDIT_CLIENT_ID": "your_id",
        "REDDIT_CLIENT_SECRET": "your_secret",
        "SCRAPEDO_API_KEY": "your_key",
        "OPENROUTER_API_KEY": "your_key"
      }
    }
  }
}
```

or quick install (for MacOS):

```
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | jq '.mcpServers["research-powerpack"] = {
  "command": "npx",
  "args": ["research-powerpack-mcp@latest"],
  "disabled": false,
  "env": {
    "OPENROUTER_API_KEY": "xxx",
    "REDDIT_CLIENT_ID": "xxx",
    "REDDIT_CLIENT_SECRET": "xxx",
    "RESEARCH_MODEL": "xxxx",
    "SCRAPEDO_API_KEY": "xxx",
    "SERPER_API_KEY": "xxxx"
  }
}' | tee ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

#### Claude Code (CLI)

One command to rule them all:

```bash
claude mcp add research-powerpack npx \
  --scope user \
  --env SERPER_API_KEY=your_key \
  --env REDDIT_CLIENT_ID=your_id \
  --env REDDIT_CLIENT_SECRET=your_secret \
  --env OPENROUTER_API_KEY=your_key \
  --env OPENROUTER_BASE_URL=https://openrouter.ai/api/v1 \
  --env RESEARCH_MODEL=x-ai/grok-4.1-fast \
  -- research-powerpack-mcp
```

Or manually add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["research-powerpack-mcp"],
      "env": {
        "SERPER_API_KEY": "your_key",
        "REDDIT_CLIENT_ID": "your_id",
        "REDDIT_CLIENT_SECRET": "your_secret",
        "OPENROUTER_API_KEY": "your_key",
        "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
        "RESEARCH_MODEL": "x-ai/grok-4.1-fast"
      }
    }
  }
}
```

#### Cursor/Windsurf

Add to `.cursor/mcp.json` or equivalent:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["research-powerpack-mcp"],
      "env": {
        "SERPER_API_KEY": "your_key"
      }
    }
  }
}
```

> **✨ Zero Crash Promise:** Missing API keys? No problem. The server always starts. Tools just return helpful setup instructions instead of exploding.

---

## ✨ Feature Breakdown: The Secret Sauce

<div align="center">

| Feature | What It Does | Why You Care |
| :---: | :--- | :--- |
| **🔍 Batch Search**<br/>`100 keywords parallel` | Search Google for up to 100 queries simultaneously | Cover every angle of a topic in one shot |
| **📊 CTR Ranking**<br/>`Smart URL scoring` | Identifies URLs that appear across multiple searches | Surfaces high-consensus authoritative sources |
| **💬 Reddit Mining**<br/>`Real human opinions` | Google-powered Reddit search + native API fetching | Get actual user experiences, not marketing fluff |
| **🎯 Smart Allocation**<br/>`Token-aware budgets` | 1,000 comment budget distributed across posts | Deep dive on 2 posts or quick scan on 50 |
| **🌐 Universal Scraping**<br/>`Works on everything` | Auto-fallback: basic → JS render → geo-targeting | Handles SPAs, paywalls, and geo-restricted content |
| **🧠 Deep Research**<br/>`AI-powered synthesis` | Batch research with web search and citations | Get comprehensive answers to complex questions |
| **🧩 Modular Design**<br/>`Use what you need` | Each tool works independently | Pay only for the APIs you actually use |

</div>

---

## 🎮 Tool Reference

<div align="center">
<table>
<tr>
<td align="center">
<h3>🔍</h3>
<b><code>web_search</code></b><br/>
<sub>Batch Google search</sub>
</td>
<td align="center">
<h3>💬</h3>
<b><code>search_reddit</code></b><br/>
<sub>Find Reddit discussions</sub>
</td>
<td align="center">
<h3>📖</h3>
<b><code>get_reddit_post</code></b><br/>
<sub>Fetch posts + comments</sub>
</td>
<td align="center">
<h3>🌐</h3>
<b><code>scrape_links</code></b><br/>
<sub>Extract any URL</sub>
</td>
<td align="center">
<h3>🧠</h3>
<b><code>deep_research</code></b><br/>
<sub>AI synthesis</sub>
</td>
</tr>
</table>
</div>

### `web_search`

**Batch web search** using Google via Serper API. Search up to 100 keywords in parallel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keywords` | `string[]` | Yes | Search queries (1-100). Use distinct keywords for maximum coverage. |

**Supports Google operators:** `site:`, `-exclusion`, `"exact phrase"`, `filetype:`

```json
{
  "keywords": [
    "best IDE 2025",
    "VS Code alternatives",
    "Cursor vs Windsurf comparison"
  ]
}
```

---

### `search_reddit`

**Search Reddit** via Google with automatic `site:reddit.com` filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `queries` | `string[]` | Yes | Search queries (max 10) |
| `date_after` | `string` | No | Filter results after date (YYYY-MM-DD) |

**Search operators:** `intitle:keyword`, `"exact phrase"`, `OR`, `-exclude`

```json
{
  "queries": [
    "best mechanical keyboard 2025",
    "intitle:keyboard recommendation"
  ],
  "date_after": "2024-01-01"
}
```

---

### `get_reddit_post`

**Fetch Reddit posts** with smart comment allocation (1,000 comment budget distributed automatically).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | `string[]` | Yes | — | Reddit post URLs (2-50) |
| `fetch_comments` | `boolean` | No | `true` | Whether to fetch comments |
| `max_comments` | `number` | No | auto | Override comment allocation |

**Smart Allocation:**
- 2 posts → ~500 comments/post (deep dive)
- 10 posts → ~100 comments/post
- 50 posts → ~20 comments/post (quick scan)

```json
{
  "urls": [
    "https://reddit.com/r/programming/comments/abc123/post_title",
    "https://reddit.com/r/webdev/comments/def456/another_post"
  ]
}
```

---

### `scrape_links`

**Universal URL content extraction** with automatic fallback modes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | `string[]` | Yes | — | URLs to scrape (3-50) |
| `timeout` | `number` | No | `30` | Timeout per URL (seconds) |
| `use_llm` | `boolean` | No | `false` | Enable AI extraction |
| `what_to_extract` | `string` | No | — | Extraction instructions for AI |

**Automatic Fallback:** Basic → JS rendering → JS + US geo-targeting

```json
{
  "urls": ["https://example.com/article1", "https://example.com/article2"],
  "use_llm": true,
  "what_to_extract": "Extract the main arguments and key statistics"
}
```

---

### `deep_research`

**AI-powered batch research** with web search and citations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | `object[]` | Yes | Research questions (2-10) |
| `questions[].question` | `string` | Yes | The research question |
| `questions[].file_attachments` | `object[]` | No | Files to include as context |

**Token Allocation:** 32,000 tokens distributed across questions:
- 2 questions → 16,000 tokens/question (deep dive)
- 10 questions → 3,200 tokens/question (rapid multi-topic)

```json
{
  "questions": [
    { "question": "What are the current best practices for React Server Components in 2025?" },
    { "question": "Compare Bun vs Node.js for production workloads with benchmarks." }
  ]
}
```

---

## ⚙️ Environment Variables & Tool Availability

Research Powerpack uses a **modular architecture**. Tools are automatically enabled based on which API keys you provide:

<div align="center">

| ENV Variable | Tools Enabled | Free Tier |
|:------------:|:-------------:|:---------:|
| `SERPER_API_KEY` | `web_search`, `search_reddit` | 2,500 queries/mo |
| `REDDIT_CLIENT_ID` + `SECRET` | `get_reddit_post` | Unlimited |
| `SCRAPEDO_API_KEY` | `scrape_links` | 1,000 credits/mo |
| `OPENROUTER_API_KEY` | `deep_research` + AI in `scrape_links` | Pay-as-you-go |
| `RESEARCH_MODEL` | Model for `deep_research` | Default: `perplexity/sonar-deep-research` |
| `LLM_EXTRACTION_MODEL` | Model for AI extraction in `scrape_links` | Default: `openrouter/gpt-oss-120b:nitro` |

</div>

### Configuration Examples

```bash
# Search-only mode (just web_search and search_reddit)
SERPER_API_KEY=xxx

# Reddit research mode (search + fetch posts)
SERPER_API_KEY=xxx
REDDIT_CLIENT_ID=xxx
REDDIT_CLIENT_SECRET=xxx

# Full research mode (all 5 tools)
SERPER_API_KEY=xxx
REDDIT_CLIENT_ID=xxx
REDDIT_CLIENT_SECRET=xxx
SCRAPEDO_API_KEY=xxx
OPENROUTER_API_KEY=xxx
```

---

## 🔑 API Key Setup Guides

<details>
<summary><b>🔍 Serper API (Google Search) — FREE: 2,500 queries/month</b></summary>

### What you get
- Fast Google search results via API
- Enables `web_search` and `search_reddit` tools

### Setup Steps
1. Go to [serper.dev](https://serper.dev)
2. Click **"Get API Key"** (top right)
3. Sign up with email or Google
4. Copy your API key from the dashboard
5. Add to your config:
   ```
   SERPER_API_KEY=your_key_here
   ```

### Pricing
- **Free**: 2,500 queries/month
- **Paid**: $50/month for 50,000 queries

</details>

<details>
<summary><b>🤖 Reddit OAuth — FREE: Unlimited access</b></summary>

### What you get
- Full Reddit API access
- Fetch posts and comments with upvote sorting
- Enables `get_reddit_post` tool

### Setup Steps
1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Scroll down and click **"create another app..."**
3. Fill in:
   - **Name**: `research-powerpack` (or any name)
   - **App type**: Select **"script"** (important!)
   - **Redirect URI**: `http://localhost:8080`
4. Click **"create app"**
5. Copy your credentials:
   - **Client ID**: The string under your app name
   - **Client Secret**: The "secret" field
6. Add to your config:
   ```
   REDDIT_CLIENT_ID=your_client_id
   REDDIT_CLIENT_SECRET=your_client_secret
   ```

</details>

<details>
<summary><b>🌐 Scrape.do (Web Scraping) — FREE: 1,000 credits/month</b></summary>

### What you get
- JavaScript rendering support
- Geo-targeting and CAPTCHA handling
- Enables `scrape_links` tool

### Setup Steps
1. Go to [scrape.do](https://scrape.do)
2. Click **"Start Free"**
3. Sign up with email
4. Copy your API key from the dashboard
5. Add to your config:
   ```
   SCRAPEDO_API_KEY=your_key_here
   ```

### Credit Usage
- **Basic scrape**: 1 credit
- **JavaScript rendering**: 5 credits
- **Geo-targeting**: +25 credits

</details>

<details>
<summary><b>🧠 OpenRouter (AI Models) — Pay-as-you-go</b></summary>

### What you get
- Access to 100+ AI models via one API
- Enables `deep_research` tool
- Enables AI extraction in `scrape_links`

### Setup Steps
1. Go to [openrouter.ai](https://openrouter.ai)
2. Sign up with Google/GitHub/email
3. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
4. Click **"Create Key"**
5. Copy the key (starts with `sk-or-...`)
6. Add to your config:
   ```
   OPENROUTER_API_KEY=sk-or-v1-xxxxx
   ```

### Recommended Models for Deep Research
```bash
# Default (optimized for research)
RESEARCH_MODEL=perplexity/sonar-deep-research

# Fast and capable
RESEARCH_MODEL=x-ai/grok-4.1-fast

# High quality
RESEARCH_MODEL=anthropic/claude-3.5-sonnet

# Budget-friendly
RESEARCH_MODEL=openai/gpt-4o-mini
```

### Recommended Models for AI Extraction (`use_llm` in `scrape_links`)
```bash
# Default (fast and cost-effective for extraction)
LLM_EXTRACTION_MODEL=openrouter/gpt-oss-120b:nitro

# High quality extraction
LLM_EXTRACTION_MODEL=anthropic/claude-3.5-sonnet

# Budget-friendly
LLM_EXTRACTION_MODEL=openai/gpt-4o-mini
```

> **Note:** `RESEARCH_MODEL` and `LLM_EXTRACTION_MODEL` are independent. You can use a powerful model for deep research and a faster/cheaper model for content extraction, or vice versa.

</details>

---

## 🔥 Recommended Workflows

### Research a Technology Decision

```
1. web_search → ["React vs Vue 2025", "Next.js vs Nuxt comparison"]
2. search_reddit → ["best frontend framework 2025", "Next.js production experience"]
3. get_reddit_post → [URLs from step 2]
4. scrape_links → [Documentation and blog URLs from step 1]
5. deep_research → [Synthesize findings into specific questions]
```

### Competitive Analysis

```
1. web_search → ["competitor name review", "competitor vs alternatives"]
2. scrape_links → [Competitor websites, review sites]
3. search_reddit → ["competitor name experience", "switching from competitor"]
4. get_reddit_post → [URLs from step 3]
```

### Debug an Obscure Error

```
1. web_search → ["exact error message", "error + framework name"]
2. search_reddit → ["error message", "framework + error type"]
3. get_reddit_post → [URLs with solutions]
4. scrape_links → [Stack Overflow answers, GitHub issues]
```

---

## 🔥 Enable Full Power Mode

For the best research experience, configure all four API keys:

```bash
SERPER_API_KEY=your_serper_key       # Free: 2,500 queries/month
REDDIT_CLIENT_ID=your_reddit_id       # Free: Unlimited
REDDIT_CLIENT_SECRET=your_reddit_secret
SCRAPEDO_API_KEY=your_scrapedo_key   # Free: 1,000 credits/month
OPENROUTER_API_KEY=your_openrouter_key # Pay-as-you-go
```

This unlocks:
- **5 research tools** working together
- **AI-powered content extraction** in scrape_links
- **Deep research with web search** and citations
- **Complete Reddit mining** (search → fetch → analyze)

**Total setup time:** ~10 minutes. **Total free tier value:** ~$50/month equivalent.

---

## 🛠️ Development

```bash
# Clone
git clone https://github.com/yigitkonur/research-powerpack-mcp.git
cd research-powerpack-mcp

# Install
npm install

# Development
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

---

## 🏗️ Architecture (v3.4.0+)

The codebase uses a **YAML-driven configuration system** with **aggressive LLM optimization** (v3.5.0+):

### Core Architecture

| Component | File | Purpose |
|-----------|------|---------|
| **Tool Definitions** | `src/config/yaml/tools.yaml` | Single source of truth for all tool metadata |
| **Handler Registry** | `src/tools/registry.ts` | Declarative tool registration + `executeTool` wrapper |
| **YAML Loader** | `src/config/loader.ts` | Parses YAML, generates MCP-compatible definitions |
| **Shared Utils** | `src/tools/utils.ts` | Common utility functions |

**Adding a new tool:**
1. Add tool definition to `tools.yaml`
2. Create handler in `src/tools/`
3. Register in `src/tools/registry.ts`

See `docs/refactoring/04-migration-guide.md` for detailed instructions.

### LLM Optimization (v3.5.0+)

All tools include **aggressive guidance** to force LLMs to use them optimally:

| Feature | Description |
|---------|-------------|
| **Configurable Limits** | All min/max values in YAML (`limits` section) |
| **BAD vs GOOD Examples** | Every tool shows anti-patterns and perfect usage |
| **Aggressive Phrasing** | Changed from "you can" to "you MUST" |
| **Visual Formatting** | Emoji headers (🔥), section dividers (━━━), icons (📊🎯❌✅) |
| **Templates** | Structured formats for questions, extractions, file descriptions |

**Key Enhancements:**
- `search_reddit`: Minimum 10 queries (was 3), 10-category formula
- `deep_research`: 7-section question template, file attachment requirements
- `scrape_links`: Extraction template with OR statements, use_llm=true push
- `web_search`: Minimum 3 keywords, search operator examples
- `file_attachments`: Numbered 5-section description template

See `docs/refactoring/07-llm-optimization-summary.md` for full details.

---

## 🔥 Common Issues & Quick Fixes

<details>
<summary><b>Expand for troubleshooting tips</b></summary>

| Problem | Solution |
| :--- | :--- |
| **Tool returns "API key not configured"** | Add the required ENV variable to your MCP config. The error message tells you exactly which key is missing. |
| **Reddit posts returning empty** | Check your `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`. Make sure you created a "script" type app. |
| **Scraping fails on JavaScript sites** | This is expected for first attempt. The tool auto-retries with JS rendering. If still failing, the site may be blocking scrapers. |
| **Deep research taking too long** | Use a faster model like `x-ai/grok-4.1-fast` instead of `perplexity/sonar-deep-research`. |
| **Token limit errors** | Reduce the number of URLs/questions per request. The tool distributes a fixed token budget. |

</details>

---

<div align="center">

**Built with 🔥 because manually researching for your AI is a soul-crushing waste of time.**

MIT © [Yiğit Konur](https://github.com/yigitkonur)

</div>
