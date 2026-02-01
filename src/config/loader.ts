/**
 * YAML Configuration Loader
 * Loads tools.yaml and generates MCP-compatible tool definitions
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type {
  YamlConfig,
  YamlToolConfig,
  YamlParameter,
  YamlValidation,
  McpTool,
  LoadedTool,
} from './types.js';

// Get directory of this file for relative YAML path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cached YAML config - loaded once, reused for all subsequent calls
let cachedYamlConfig: YamlConfig | null = null;

// ============================================================================
// YAML to Zod Schema Conversion
// ============================================================================

/**
 * Convert YAML validation rules to Zod string schema
 */
function applyStringValidation(schema: z.ZodString, validation?: YamlValidation): z.ZodString {
  if (!validation) return schema;

  let result = schema;
  if (validation.minLength !== undefined) result = result.min(validation.minLength);
  if (validation.maxLength !== undefined) result = result.max(validation.maxLength);
  if (validation.pattern) result = result.regex(new RegExp(validation.pattern));
  if (validation.format === 'uri') result = result.url();
  if (validation.format === 'email') result = result.email();
  if (validation.format === 'uuid') result = result.uuid();

  return result;
}

/**
 * Convert YAML validation rules to Zod number schema
 */
function applyNumberValidation(schema: z.ZodNumber, validation?: YamlValidation): z.ZodNumber {
  if (!validation) return schema;

  let result = schema;
  if (validation.min !== undefined) result = result.min(validation.min);
  if (validation.max !== undefined) result = result.max(validation.max);
  if (validation.int) result = result.int();
  if (validation.positive) result = result.positive();
  if (validation.negative) result = result.negative();

  return result;
}

/**
 * Convert YAML validation rules to Zod array schema
 */
function applyArrayValidation<T>(
  schema: z.ZodArray<z.ZodTypeAny>,
  validation?: YamlValidation
): z.ZodArray<z.ZodTypeAny> {
  if (!validation) return schema;

  let result = schema;
  if (validation.minItems !== undefined) result = result.min(validation.minItems);
  if (validation.maxItems !== undefined) result = result.max(validation.maxItems);

  return result;
}

/**
 * Recursively convert YAML parameter to Zod schema
 */
function yamlParamToZod(param: YamlParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (param.type) {
    case 'string': {
      let strSchema = z.string();
      strSchema = applyStringValidation(strSchema, param.validation);
      if (param.description) strSchema = strSchema.describe(param.description);
      schema = strSchema;
      break;
    }

    case 'number': {
      let numSchema = z.number();
      numSchema = applyNumberValidation(numSchema, param.validation);
      if (param.description) numSchema = numSchema.describe(param.description);
      schema = numSchema;
      break;
    }

    case 'boolean': {
      let boolSchema = z.boolean();
      if (param.description) boolSchema = boolSchema.describe(param.description);
      schema = boolSchema;
      break;
    }

    case 'array': {
      if (!param.items) {
        throw new Error('Array parameter must have items definition');
      }
      const itemSchema = yamlParamToZod(param.items);
      let arrSchema = z.array(itemSchema);
      arrSchema = applyArrayValidation(arrSchema, param.validation);
      if (param.description) arrSchema = arrSchema.describe(param.description);
      schema = arrSchema;
      break;
    }

    case 'object': {
      if (!param.properties) {
        throw new Error('Object parameter must have properties definition');
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propDef] of Object.entries(param.properties)) {
        let propSchema = yamlParamToZod(propDef);
        if (propDef.required === false) {
          propSchema = propSchema.optional();
        }
        shape[key] = propSchema;
      }
      let objSchema = z.object(shape);
      if (param.description) objSchema = objSchema.describe(param.description);
      schema = objSchema;
      break;
    }

    default:
      throw new Error(`Unknown parameter type: ${param.type}`);
  }

  // Apply optional/default
  if (param.required === false && param.default !== undefined) {
    schema = schema.default(param.default);
  } else if (param.required === false) {
    schema = schema.optional();
  }

  return schema;
}

/**
 * Convert YAML parameters to Zod object schema
 */
function yamlParamsToZodSchema(
  params: Record<string, YamlParameter>
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, param] of Object.entries(params)) {
    let schema = yamlParamToZod(param);
    // Note: required is handled in yamlParamToZod via optional()
    shape[key] = schema;
  }

  return z.object(shape);
}

/**
 * Convert Zod schema to JSON Schema for MCP inputSchema
 */
function zodToMcpInputSchema(schema: z.ZodTypeAny): McpTool['inputSchema'] {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: 'none' });

  // Extract properties and required from JSON Schema
  if (typeof jsonSchema === 'object' && jsonSchema !== null) {
    const obj = jsonSchema as Record<string, unknown>;
    return {
      type: 'object' as const,
      properties: (obj.properties as Record<string, unknown>) || {},
      required: obj.required as string[] | undefined,
    };
  }

  return { type: 'object' as const, properties: {} };
}

// ============================================================================
// Tool Loading
// ============================================================================

/**
 * Load and parse tools.yaml
 */
export function loadYamlConfig(): YamlConfig {
  if (cachedYamlConfig) return cachedYamlConfig;
  const yamlPath = join(__dirname, 'yaml', 'tools.yaml');
  const yamlContent = readFileSync(yamlPath, 'utf8');
  cachedYamlConfig = parseYaml(yamlContent) as YamlConfig;
  return cachedYamlConfig;
}

/**
 * Convert a single YAML tool config to MCP Tool
 * For tools with inline parameters only
 */
function yamlToolToMcpTool(toolConfig: YamlToolConfig): LoadedTool {
  if (!toolConfig.parameters) {
    throw new Error(`Tool ${toolConfig.name} must have parameters or useZodSchema`);
  }

  const zodSchema = yamlParamsToZodSchema(toolConfig.parameters);
  const inputSchema = zodToMcpInputSchema(zodSchema);

  return {
    name: toolConfig.name,
    description: toolConfig.description.trim(),
    inputSchema,
    category: toolConfig.category,
    capability: toolConfig.capability,
    useZodSchema: false,
  };
}

/**
 * Create placeholder for tools using existing Zod schemas
 * These will be enriched with actual schemas at runtime
 */
function createZodSchemaPlaceholder(toolConfig: YamlToolConfig): LoadedTool {
  return {
    name: toolConfig.name,
    description: toolConfig.description.trim(),
    inputSchema: { type: 'object' as const, properties: {} }, // Placeholder
    category: toolConfig.category,
    capability: toolConfig.capability,
    useZodSchema: true,
    zodSchemaRef: toolConfig.zodSchemaRef,
  };
}

/**
 * Load all tools from YAML configuration
 */
export function loadToolsFromYaml(): LoadedTool[] {
  const config = loadYamlConfig();

  return config.tools.map((toolConfig) => {
    if (toolConfig.useZodSchema) {
      // Tool uses existing Zod schema - return placeholder
      return createZodSchemaPlaceholder(toolConfig);
    } else {
      // Tool has inline parameters - generate schema from YAML
      return yamlToolToMcpTool(toolConfig);
    }
  });
}

/**
 * Get tool configuration by name
 */
export function getToolConfig(name: string): YamlToolConfig | undefined {
  const config = loadYamlConfig();
  return config.tools.find((t) => t.name === name);
}

/**
 * Get schema descriptions for a tool (for injecting into existing Zod schemas)
 */
export function getSchemaDescriptions(name: string): Record<string, string> | undefined {
  const tool = getToolConfig(name);
  return tool?.schemaDescriptions;
}

// ============================================================================
// Zod Schema Registry (for tools using existing schemas)
// ============================================================================

import { deepResearchParamsSchema } from '../schemas/deep-research.js';
import { scrapeLinksParamsSchema } from '../schemas/scrape-links.js';
import { webSearchParamsSchema } from '../schemas/web-search.js';

/**
 * Registry of existing Zod schemas for complex tools
 */
const zodSchemaRegistry: Record<string, z.ZodTypeAny> = {
  deepResearchParamsSchema,
  scrapeLinksParamsSchema,
  webSearchParamsSchema,
};

/**
 * Get Zod schema by reference name
 */
export function getZodSchemaByRef(ref: string): z.ZodTypeAny | undefined {
  return zodSchemaRegistry[ref];
}

/**
 * Generate complete MCP tools list with all schemas resolved
 */
export function generateMcpTools(): McpTool[] {
  const loadedTools = loadToolsFromYaml();

  return loadedTools.map((tool) => {
    if (tool.useZodSchema && tool.zodSchemaRef) {
      // Resolve the actual Zod schema
      const schema = getZodSchemaByRef(tool.zodSchemaRef);
      if (!schema) {
        console.error(`[Loader] Schema not found: ${tool.zodSchemaRef}`);
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object' as const, properties: {} },
        };
      }

      const inputSchema = zodToMcpInputSchema(schema);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
      };
    }

    // Tool already has generated inputSchema
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  });
}

// ============================================================================
// Exports
// ============================================================================

export { yamlParamsToZodSchema, yamlParamToZod };
