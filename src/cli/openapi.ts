/**
 * OpenAPI Specification Generator
 *
 * Generates OpenAPI 3.1 specs from route registry metadata.
 * Enables API documentation and client code generation.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  RouteRegistry,
  type RouteMetadata,
} from '../effect/route-registry.js'
import { loadAppRouteRegistry } from './load-app.js'
import type { Schema as S } from 'effect'
import * as JSONSchema from 'effect/JSONSchema'

/**
 * OpenAPI info object.
 */
export interface OpenApiInfo {
  title: string
  version: string
  description?: string
  contact?: {
    name?: string
    url?: string
    email?: string
  }
  license?: {
    name: string
    url?: string
  }
}

/**
 * OpenAPI server object.
 */
export interface OpenApiServer {
  url: string
  description?: string
}

/**
 * OpenAPI tag object.
 */
export interface OpenApiTag {
  name: string
  description?: string
}

/**
 * Options for OpenAPI generation.
 */
export interface GenerateOpenApiOptions {
  /**
   * API info.
   */
  info: OpenApiInfo
  /**
   * Server URLs.
   */
  servers?: OpenApiServer[]
  /**
   * Tags for grouping operations.
   */
  tags?: OpenApiTag[]
  /**
   * Base path to prefix all routes.
   */
  basePath?: string
  /**
   * Include routes matching these prefixes only.
   */
  includePrefixes?: string[]
  /**
   * Exclude routes matching these prefixes.
   */
  excludePrefixes?: string[]
  /**
   * Custom security schemes.
   */
  securitySchemes?: Record<string, OpenApiSecurityScheme>
  /**
   * Default security requirement.
   */
  defaultSecurity?: Array<Record<string, string[]>>
}

/**
 * OpenAPI security scheme.
 */
export interface OpenApiSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect'
  description?: string
  name?: string
  in?: 'query' | 'header' | 'cookie'
  scheme?: string
  bearerFormat?: string
  flows?: Record<string, unknown>
  openIdConnectUrl?: string
}

/**
 * OpenAPI parameter object.
 */
export interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema: OpenApiSchema
}

/**
 * OpenAPI schema object (simplified).
 */
export type OpenApiSchema = JSONSchema.JsonSchema7

/**
 * OpenAPI response object.
 */
export interface OpenApiResponse {
  description: string
  content?: Record<string, { schema: OpenApiSchema }>
}

/**
 * OpenAPI operation object.
 */
export interface OpenApiOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: OpenApiParameter[]
  requestBody?: {
    required?: boolean
    content: Record<string, { schema: OpenApiSchema }>
  }
  responses: Record<string, OpenApiResponse>
  security?: Array<Record<string, string[]>>
}

/**
 * OpenAPI path item object.
 */
export type OpenApiPathItem = {
  [method in 'get' | 'post' | 'put' | 'patch' | 'delete']?: OpenApiOperation
}

/**
 * Full OpenAPI specification.
 */
export interface OpenApiSpec {
  openapi: '3.1.0'
  info: OpenApiInfo
  servers?: OpenApiServer[]
  tags?: OpenApiTag[]
  paths: Record<string, OpenApiPathItem>
  components?: {
    schemas?: Record<string, OpenApiSchema>
    securitySchemes?: Record<string, OpenApiSecurityScheme>
  }
  security?: Array<Record<string, string[]>>
}

/**
 * Convert route path to OpenAPI path format.
 * Converts :param to {param} format.
 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}')
}

function toOpenApiSchema(schema: S.Schema.Any): OpenApiSchema {
  const jsonSchema = JSONSchema.make(schema, { target: 'openApi3.1' })
  const { $schema, ...rest } = jsonSchema
  return rest as OpenApiSchema
}

function stringSchema(format?: string): OpenApiSchema {
  const schema: OpenApiSchema = format ? { type: 'string', format } : { type: 'string' }
  return schema
}

function objectSchema(
  properties: Record<string, OpenApiSchema> = {},
  required: string[] = [],
  description?: string
): OpenApiSchema {
  const schema: OpenApiSchema = {
    type: 'object',
    properties,
    required,
    ...(description ? { description } : {}),
  }
  return schema
}

/**
 * Extract tag from route name or path.
 */
function extractTag(route: RouteMetadata): string {
  if (route.name) {
    const parts = route.name.split('.')
    if (parts.length > 1) {
      return parts[0]
    }
  }

  // Extract from path
  const match = route.fullPath.match(/^\/([^/]+)/)
  return match ? match[1] : 'default'
}

/**
 * Generate operation ID from route.
 */
function generateOperationId(route: RouteMetadata): string {
  if (route.name) {
    return route.name.replace(/\./g, '_')
  }

  const pathParts = route.fullPath
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/[{}:]/g, ''))
    .join('_')

  return `${route.method}_${pathParts}`
}

/**
 * Generate summary from route.
 */
function generateSummary(route: RouteMetadata): string {
  if (route.name) {
    const parts = route.name.split('.')
    if (parts.length === 2) {
      const action = parts[1]
      const resource = parts[0].slice(0, -1) // Remove 's' from plural

      switch (action) {
        case 'index':
          return `List all ${parts[0]}`
        case 'show':
          return `Get a ${resource}`
        case 'create':
          return `Create a new ${resource}`
        case 'update':
          return `Update a ${resource}`
        case 'destroy':
          return `Delete a ${resource}`
        default:
          return `${action.charAt(0).toUpperCase() + action.slice(1)} ${resource}`
      }
    }
  }

  return `${route.method.toUpperCase()} ${route.fullPath}`
}

/**
 * Generate parameters from route bindings.
 */
function generateQueryParameters(route: RouteMetadata): OpenApiParameter[] {
  if (!route.querySchema) return []

  const schema = toOpenApiSchema(route.querySchema)
  if (
    schema &&
    typeof schema === 'object' &&
    'properties' in schema &&
    schema.properties &&
    typeof schema.properties === 'object'
  ) {
    const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set<string>()
    return Object.entries(schema.properties).map(([name, propertySchema]) => ({
      name,
      in: 'query' as const,
      required: required.has(name),
      schema: propertySchema as OpenApiSchema,
    }))
  }

  return [
    {
      name: 'query',
      in: 'query' as const,
      schema,
    },
  ]
}

function generateParameters(route: RouteMetadata): OpenApiParameter[] {
  const pathParameters: OpenApiParameter[] = route.bindings.map((binding) => ({
    name: binding.param,
    in: 'path' as const,
    required: true,
    description: `The ${binding.param} identifier`,
    schema: stringSchema(binding.column === 'id' ? 'uuid' : undefined),
  }))

  return pathParameters.concat(generateQueryParameters(route))
}

/**
 * Generate default responses for an operation.
 */
function generateResponses(route: RouteMetadata): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {}
  const responseSchema = route.responseSchema
    ? toOpenApiSchema(route.responseSchema)
    : objectSchema()

  switch (route.method) {
    case 'get':
      responses['200'] = {
        description: 'Successful response',
        content: {
          'application/json': {
            schema: responseSchema,
          },
        },
      }
      break
    case 'post':
      responses['201'] = {
        description: 'Resource created',
        content: {
          'application/json': {
            schema: responseSchema,
          },
        },
      }
      responses['422'] = {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: objectSchema({
              errors: objectSchema({}, [], 'Field-level validation errors'),
            }),
          },
        },
      }
      break
    case 'put':
    case 'patch':
      responses['200'] = {
        description: 'Resource updated',
        content: {
          'application/json': {
            schema: responseSchema,
          },
        },
      }
      responses['422'] = {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: objectSchema({
              errors: objectSchema(),
            }),
          },
        },
      }
      break
    case 'delete':
      responses['204'] = {
        description: 'Resource deleted',
      }
      break
  }

  // Common error responses
  if (route.bindings.length > 0) {
    responses['404'] = {
      description: 'Resource not found',
      content: {
        'application/json': {
          schema: objectSchema({
            error: stringSchema(),
            code: stringSchema(),
          }),
        },
      },
    }
  }

  responses['401'] = {
    description: 'Unauthorized',
  }

  return responses
}

/**
 * Generate request body for non-GET operations.
 */
function generateRequestBody(route: RouteMetadata): OpenApiOperation['requestBody'] | undefined {
  if (route.method === 'get' || route.method === 'delete') {
    return undefined
  }

  const requestSchema = route.bodySchema
    ? toOpenApiSchema(route.bodySchema)
    : objectSchema({}, [], 'Request body')

  return {
    required: true,
    content: {
      'application/json': {
        schema: requestSchema,
      },
    },
  }
}

/**
 * Generate OpenAPI specification from route registry.
 *
 * @example
 * ```typescript
 * import { generateOpenApi, getGlobalRegistry } from '@popcomputer/web/cli'
 *
 * // After routes are registered
 * const spec = generateOpenApi(getGlobalRegistry(), {
 *   info: { title: 'My API', version: '1.0.0' },
 *   servers: [{ url: 'https://api.example.com' }],
 * })
 *
 * // Write to file
 * Bun.write('openapi.json', JSON.stringify(spec, null, 2))
 * ```
 */
export function generateOpenApi(
  registry: RouteRegistry,
  options: GenerateOpenApiOptions
): OpenApiSpec {
  const routes = registry.all()

  // Filter routes
  let filteredRoutes = routes
  if (options.includePrefixes?.length) {
    filteredRoutes = filteredRoutes.filter((r) =>
      options.includePrefixes!.some((p) => r.fullPath.startsWith(p))
    )
  }
  if (options.excludePrefixes?.length) {
    filteredRoutes = filteredRoutes.filter((r) =>
      !options.excludePrefixes!.some((p) => r.fullPath.startsWith(p))
    )
  }

  // Build paths
  const paths: Record<string, OpenApiPathItem> = {}
  const tagSet = new Set<string>()

  for (const route of filteredRoutes) {
    const openApiPath = toOpenApiPath(route.fullPath)
    const tag = extractTag(route)
    tagSet.add(tag)

    if (!paths[openApiPath]) {
      paths[openApiPath] = {}
    }

    const operation: OpenApiOperation = {
      operationId: generateOperationId(route),
      summary: generateSummary(route),
      tags: [tag],
      parameters: generateParameters(route),
      requestBody: generateRequestBody(route),
      responses: generateResponses(route),
    }

    if (options.defaultSecurity) {
      operation.security = options.defaultSecurity
    }

    if (route.method !== 'all') {
      paths[openApiPath][route.method] = operation
    }
  }

  // Build tags from discovered tag names
  const tags: OpenApiTag[] = options.tags ?? Array.from(tagSet).map((name) => ({
    name,
    description: `${name.charAt(0).toUpperCase() + name.slice(1)} operations`,
  }))

  // Build spec
  const spec: OpenApiSpec = {
    openapi: '3.1.0',
    info: options.info,
    paths,
    tags,
  }

  if (options.servers) {
    spec.servers = options.servers
  }

  if (options.securitySchemes || options.defaultSecurity) {
    spec.components = {}
    if (options.securitySchemes) {
      spec.components.securitySchemes = options.securitySchemes
    }
  }

  if (options.defaultSecurity) {
    spec.security = options.defaultSecurity
  }

  return spec
}

function formatYamlScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value !== 'string') {
    return JSON.stringify(value)
  }

  if (value.length === 0) {
    return "''"
  }

  const needsQuotes =
    /^\s|\s$/.test(value) ||
    /[:#[\]{}&,*!?|>'"%@`]/.test(value) ||
    /^(true|false|null|~|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(value)

  return needsQuotes ? JSON.stringify(value) : value
}

function toYaml(value: unknown, indent = 0): string {
  const padding = '  '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${padding}[]`
    }

    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const nested = toYaml(item, indent + 1)
          return `${padding}-\n${nested}`
        }

        return `${padding}- ${formatYamlScalar(item)}`
      })
      .join('\n')
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      return `${padding}{}`
    }

    return entries
      .map(([key, item]) => {
        const safeKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)

        if (item !== null && typeof item === 'object') {
          const nested = toYaml(item, indent + 1)
          return `${padding}${safeKey}:\n${nested}`
        }

        return `${padding}${safeKey}: ${formatYamlScalar(item)}`
      })
      .join('\n')
  }

  return `${padding}${formatYamlScalar(value)}`
}

export function formatOpenApiOutput(
  spec: OpenApiSpec,
  format: 'json' | 'yaml' = 'json'
): string {
  if (format === 'yaml') {
    return `${toYaml(spec)}\n`
  }

  return `${JSON.stringify(spec, null, 2)}\n`
}

function writeOutputFile(outputPath: string, content: string): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content, 'utf-8')
}

/**
 * Options for the generate:openapi CLI command.
 */
export interface GenerateOpenApiCliOptions {
  app?: string
  title?: string
  version?: string
  description?: string
  output?: string
  format?: 'json' | 'yaml'
  server?: string
  includePrefixes?: string[]
  excludePrefixes?: string[]
  preview?: boolean
}

/**
 * Parse CLI arguments for generate:openapi command.
 */
export function parseGenerateOpenApiArgs(args: string[]): GenerateOpenApiCliOptions {
  const options: GenerateOpenApiCliOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--app':
        options.app = args[++i]
        break
      case '--title':
      case '-t':
        options.title = args[++i]
        break
      case '--version':
      case '-v':
        options.version = args[++i]
        break
      case '--description':
      case '-d':
        options.description = args[++i]
        break
      case '--output':
      case '-o':
        options.output = args[++i]
        break
      case '--format':
      case '-f':
        options.format = args[++i] as 'json' | 'yaml'
        break
      case '--server':
      case '-s':
        options.server = args[++i]
        break
      case '--include':
        options.includePrefixes = args[++i]?.split(',')
        break
      case '--exclude':
        options.excludePrefixes = args[++i]?.split(',')
        break
      case '--preview':
        options.preview = true
        break
    }
  }

  return options
}

/**
 * Get help text for the generate:openapi command.
 */
export function generateOpenApiHelp(): string {
  return `
popweb generate:openapi - Generate OpenAPI 3.1 specification

USAGE:
  popweb generate:openapi --app <entrypoint> [OPTIONS]

OPTIONS:
  --app <path>         Application entrypoint exporting the app or route registry
  -t, --title         API title (default: 'API')
  -v, --version       API version (default: '1.0.0')
  -d, --description   API description
  -o, --output        Output file path (default: stdout)
  -f, --format        Output format: json, yaml (default: json)
  -s, --server        Server URL
  --include           Include only routes with these prefixes (comma-separated)
  --exclude           Exclude routes with these prefixes (comma-separated)
  --preview           Preview without writing file

EXAMPLES:
  # Generate OpenAPI spec
  popweb generate:openapi --app src/app.ts --title "My API" --version "1.0.0"

  # Output to file
  popweb generate:openapi --app src/app.ts -o openapi.json

  # Include only API routes
  popweb generate:openapi --app src/app.ts --include /api

  # Exclude internal routes
  popweb generate:openapi --app src/app.ts --exclude /internal,/admin

  # Add server URL
  popweb generate:openapi --app src/app.ts --server https://api.example.com
`.trim()
}

/**
 * Run the generate:openapi command.
 */
export async function runGenerateOpenApi(
  args: string[] = [],
  registry?: RouteRegistry
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(generateOpenApiHelp())
    return
  }

  const cliOptions = parseGenerateOpenApiArgs(args)
  const resolvedRegistry = registry ?? (
    cliOptions.app ? await loadAppRouteRegistry(cliOptions.app) : undefined
  )
  if (!resolvedRegistry) {
    throw new Error('Missing application entrypoint. Pass --app src/app.ts.')
  }

  const spec = generateOpenApi(resolvedRegistry, {
    info: {
      title: cliOptions.title ?? 'API',
      version: cliOptions.version ?? '1.0.0',
      description: cliOptions.description,
    },
    servers: cliOptions.server ? [{ url: cliOptions.server }] : undefined,
    includePrefixes: cliOptions.includePrefixes,
    excludePrefixes: cliOptions.excludePrefixes,
  })

  const format = cliOptions.format ?? 'json'
  const output = formatOpenApiOutput(spec, format)

  if (cliOptions.preview || !cliOptions.output) {
    console.log(output)
    return
  }

  writeOutputFile(cliOptions.output, output)
  console.log(`Generated OpenAPI spec: ${cliOptions.output}`)
  console.log(`Format: ${format}`)
  console.log(`Routes documented: ${Object.keys(spec.paths).length}`)
}
