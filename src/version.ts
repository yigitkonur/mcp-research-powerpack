/**
 * Version Module - Single Source of Truth
 * 
 * This module reads the version from package.json at runtime.
 * All version references in the codebase should import from here.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Create a require function for ESM to import JSON
const require = createRequire(import.meta.url);

// Get the directory of this file to find package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package.json - works from both src/ and dist/
let packageJson: { version: string; name: string; description: string };

try {
  // Try loading from project root (when running from dist/)
  packageJson = require(join(__dirname, '..', 'package.json'));
} catch {
  try {
    // Try loading from two levels up (when running from src/)
    packageJson = require(join(__dirname, '..', '..', 'package.json'));
  } catch {
    // Fallback if package.json can't be found
    console.error('[Version] Warning: Could not load package.json');
    packageJson = {
      version: '0.0.0-unknown',
      name: 'research-powerpack-mcp',
      description: 'Research Powerpack MCP Server',
    };
  }
}

/** Package version from package.json - single source of truth */
export const VERSION: string = packageJson.version;

/** Package name from package.json */
export const PACKAGE_NAME: string = packageJson.name;

/** Package description from package.json */
export const PACKAGE_DESCRIPTION: string = packageJson.description;

/** Formatted version string for user agents */
export const USER_AGENT_VERSION: string = `${PACKAGE_NAME}/${VERSION}`;

/** Full version info object */
export const VERSION_INFO = {
  version: VERSION,
  name: PACKAGE_NAME,
  description: PACKAGE_DESCRIPTION,
  userAgent: USER_AGENT_VERSION,
} as const;

export default VERSION;
