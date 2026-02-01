# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.1] - 2026-01-31

### Performance

- **Bounded Concurrency** - All parallel operations now use a worker-pool pattern (`pMap`/`pMapSettled`) instead of unbounded `Promise.all`
  - Reddit search: 50 concurrent API calls → 8
  - Web scraping batches: 30 concurrent → 10
  - Deep research questions: unbounded → 3
  - Reddit post fetching: 10 concurrent → 5
  - File attachments: unbounded → 5

- **YAML Config Caching** - `loadYamlConfig()` now caches the parsed YAML in memory instead of reading from disk on every call via `readFileSync`. This eliminates redundant I/O for `getToolConfig()`, `getExtractionSuffix()`, and all config lookups.

- **Async File I/O** - Replaced blocking `existsSync()` in `FileAttachmentService` with async `access()` from `fs/promises` to avoid blocking the event loop.

- **String Concatenation** - Replaced `output +=` loops in `formatCodeBlock()` and `formatAttachments()` with `Array.push()` + `join('')` pattern, eliminating O(n^2) allocations for large files (600+ lines).

- **Module-Level Singletons** - Hoisted `MarkdownCleaner` instance in `scrape.ts` to module level (stateless, reused across requests).

- **Pre-compiled Regex** - Moved Reddit search regex patterns (`/site:\s*reddit\.com/i`, title cleanup regexes) to module-level constants in `search.ts`.

- **Environment Caching** - `parseEnv()` results cached in memory (single read at startup).

### Fixed

- **URL Aggregator Position Logic** - Fixed title/snippet selection in both `aggregateResults()` and `aggregateRedditResults()`. Previously compared against `positions[0]` (first position recorded) instead of the previous best position, which could keep stale metadata when a better-ranked result appeared later.

- **Non-null Assertion Safety** - Replaced `env.SEARCH_API_KEY!`, `env.REDDIT_CLIENT_ID!`, `env.REDDIT_CLIENT_SECRET!` non-null assertions in `registry.ts` with safe `|| ''` fallbacks to prevent runtime crashes if env vars are missing.

- **Reddit Auth Race Condition** - Added promise deduplication (`pendingAuthPromise`) to prevent multiple concurrent `auth()` calls from firing redundant token requests.

### Added

- **`src/utils/concurrency.ts`** - New utility module with `pMap()` (ordered results) and `pMapSettled()` (per-item error isolation) for bounded concurrent execution across the codebase.

## [3.5.0] - 2026-01-04

### Added - LLM Optimization & Aggressive Guidance

- **Aggressive Tool Descriptions** - Transformed all tool descriptions from passive to directive
  - `search_reddit`: Minimum 10 queries enforced (was 3), added 10-category query formula
  - `get_reddit_post`: Stress on using 10-20+ posts for consensus (was 2+)
  - `deep_research`: Enhanced template with numbered sections, file attachment requirements
  - `scrape_links`: Aggressive push for `use_llm=true`, extraction template with OR statements
  - `web_search`: Minimum 3 keywords enforced, search operator examples

- **BAD vs GOOD Examples** - Every tool now shows anti-patterns and perfect examples
  - Visual comparison with ❌ BAD and ✅ GOOD sections
  - Explains WHY each example is bad/good
  - Provides actionable fixes for common mistakes

- **Configurable Limits in YAML** - All limits moved to YAML configuration
  - `limits` section in each tool definition
  - `min_queries`, `max_queries`, `recommended_queries` for search_reddit
  - `min_urls`, `max_urls`, `recommended_urls` for scrape_links and get_reddit_post
  - `min_keywords`, `max_keywords`, `recommended_keywords` for web_search
  - `min_questions`, `max_questions`, `recommended_questions` for deep_research

- **File Attachment Template** - Numbered 5-section format for file descriptions
  - [1] What this file is
  - [2] Why it's relevant
  - [3] What to focus on
  - [4] Known issues/context
  - [5] Related files
  - Includes examples for bugs, performance, refactoring, architecture scenarios

- **Extraction Prompt Templates** - Comprehensive guidance for scrape_links
  - OR-statement formula: "Extract [target1] | [target2] | [target3]"
  - Examples by use case (product research, technical docs, competitive analysis)
  - Minimum 3 extraction targets recommended

- **Query Crafting Strategies** - Detailed examples for search_reddit and web_search
  - Technology research examples
  - Problem-solving examples
  - Comparison research examples
  - Search operator usage (site:, "exact", -exclude, filetype:, OR)

### Changed

- **Tool Descriptions** - Increased verbosity and directiveness
  - Added 🔥 emoji headers for critical requirements
  - Added ━━━ section dividers for readability
  - Added emoji icons (📊, 🎯, ❌, ✅, 💡, 🚀) for visual scanning
  - Changed from "you can" to "you MUST" phrasing
  - Increased emphasis on parallel processing benefits

- **Validation Requirements** - Stricter minimum requirements
  - `search_reddit`: 3 → 10 minimum queries
  - `web_search`: 1 → 3 minimum keywords
  - All tools: Added recommended ranges

- **Sequential Thinking Workflows** - Iterative refinement patterns for all research tools
  - Think → Search → Think → Refine → Search Again pattern
  - Mandatory thinking steps between tool calls
  - Scope expansion based on results
  - Examples of iterative flows for each tool
  - Feedback loop guidance (results inform next search)

### Documentation

- Added `docs/refactoring/06-validation-system-design.md` - Validation architecture
- Added `docs/refactoring/07-llm-optimization-summary.md` - Quick reference guide

## [3.4.0] - 2026-01-04

### Added

- **YAML Configuration System** - All tool metadata now lives in a single `tools.yaml` file
  - Tool descriptions, parameter schemas, and validation rules centralized
  - Easy to update without touching TypeScript code
  - Single source of truth for all tool definitions

- **Handler Registry Pattern** - New `src/tools/registry.ts` with `executeTool` wrapper
  - Declarative tool registration with capability checks
  - Automatic Zod validation for all tools
  - Consistent error handling across all tools
  - Reduced routing code from 80+ lines to single function call

- **Shared Utility Functions** - New `src/tools/utils.ts`
  - `safeLog()` - Logger wrapper that never throws
  - `calculateTokenAllocation()` - Batch token distribution
  - `formatRetryHint()` - Error message formatting
  - `formatToolError()` - Standard error response builder
  - Validation helpers for arrays and bounds

- **YAML Loader Infrastructure** - New `src/config/loader.ts` and `src/config/types.ts`
  - Parses `tools.yaml` at startup
  - Generates MCP-compatible tool definitions
  - Supports both inline parameters and existing Zod schemas
  - Type-safe TypeScript interfaces for YAML config

- **Comprehensive Refactoring Documentation** - 5 design docs in `docs/refactoring/`
  - Architecture overview
  - YAML schema design specification
  - Handler registry design
  - Migration guide for adding new tools
  - Final summary with metrics

### Changed

- **`src/tools/definitions.ts`** - Reduced from 167 lines to 19 lines (-88%)
  - Now imports from YAML loader instead of hardcoded definitions

- **`src/index.ts`** - Reduced from 263 lines to 143 lines (-46%)
  - Uses `executeTool` from registry instead of if/else blocks
  - Uses `getToolCapabilities()` for startup logging

- **Build Process** - Updated to copy YAML files to dist
  - `npm run build` now includes `cp -r src/config/yaml dist/config/`

### Dependencies

- Added `yaml` package (^2.7.0) for YAML parsing

### Technical Details

- Exported `Capabilities` interface from `src/config/index.ts`
- Added index signature to `CallToolResult` for MCP SDK compatibility
- Handler wrappers accept `unknown` params with internal type casting

## [3.3.2] - Previous Release

See git history for earlier changes.
