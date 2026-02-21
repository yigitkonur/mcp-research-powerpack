/**
 * Version Module - Single Source of Truth
 * 
 * This module reads the version from package.json at runtime when running in
 * Node.js, and falls back to hardcoded values in Cloudflare Workers where
 * filesystem access is unavailable.
 * 
 * Usage:
 *   import { VERSION, PACKAGE_NAME } from './version.js';
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Defaults used when running in Workers or if package.json cannot be loaded
let packageJson: { version: string; name: string; description: string } = {
  version: '3.6.9',
  name: 'mcp-research-powerpack',
  description: 'Research Powerpack MCP Server',
};

try {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
    const _require = createRequire(import.meta.url);
    const _dirname = dirname(fileURLToPath(import.meta.url));
    try {
      packageJson = _require(join(_dirname, '..', 'package.json'));
    } catch {
      packageJson = _require(join(_dirname, '..', '..', 'package.json'));
    }
  }
} catch {
  // Workers / edge runtime – keep hardcoded defaults
}

/**
 * Package version from package.json
 * This is the single source of truth for versioning
 */
export const VERSION: string = packageJson.version;

/**
 * Package name from package.json
 */
export const PACKAGE_NAME: string = packageJson.name;

/**
 * Package description from package.json
 */
export const PACKAGE_DESCRIPTION: string = packageJson.description;

/**
 * Formatted version string for user agents and logging
 * Example: "mcp-research-powerpack/3.2.0"
 */
export const USER_AGENT_VERSION: string = `${PACKAGE_NAME}/${VERSION}`;

// VERSION_INFO removed - unused, individual exports sufficient
