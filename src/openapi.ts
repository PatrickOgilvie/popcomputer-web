/**
 * An OpenAPI 3.1 description of an application's endpoints, built from their
 * contracts, so the published description and the running API cannot drift.
 */

import { Schema as S } from 'effect'
import { ErrorResponse } from './effect/error-response.js'
import type { Endpoint, EndpointSchema, EndpointSpec } from './endpoint.js'

/** A JSON value, as the description holds them. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }

type JsonObject = { readonly [key: string]: JsonValue }

/** What the description says about the API itself. */
export interface OpenApiInfo {
  readonly title: string
  readonly version: string
  readonly description?: string
  /** Where the API answers, such as `https://api.example.com`. */
  readonly servers?: ReadonlyArray<string>
}

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON Schema document as Effect writes it: the schema, and the definitions its `$ref`s name. */
interface SchemaDocument {
  readonly schema: JsonObject
  readonly definitions: Readonly<Record<string, JsonObject>>
}

function documentOf(schema: S.Top): SchemaDocument {
  // SAFETY: Effect's JSON Schema documents are JSON.
  const document = S.toJsonSchemaDocument(schema) as unknown as { schema: JsonObject; definitions?: Record<string, JsonObject> }

  return { schema: document.schema, definitions: document.definitions ?? {} }
}

/**
 * Where the encoded side says nothing, as it does for a validator that
 * accepts form posts as well as JSON (it decodes from anything), the decoded
 * side's JSON form says what a JSON client sends; elsewhere the encoded side
 * is the wire format. Objects keep the encoded side's `required`.
 */
function mergeWire(encoded: JsonValue | undefined, decoded: JsonValue | undefined): JsonValue | undefined {
  if (!isObject(encoded)) return encoded ?? decoded
  if (Object.keys(encoded).length === 0) return decoded ?? encoded
  if (!isObject(decoded)) return encoded

  const merged: Record<string, JsonValue> = { ...encoded }
  const encodedProperties = encoded.properties
  const decodedProperties = decoded.properties

  if (isObject(encodedProperties)) {
    const properties: Record<string, JsonValue> = {}

    for (const [key, value] of Object.entries(encodedProperties)) {
      properties[key] = mergeWire(value, isObject(decodedProperties) ? decodedProperties[key] : undefined) ?? value
    }

    merged.properties = properties
  }

  if (encoded.items !== undefined) merged.items = mergeWire(encoded.items, decoded.items) ?? encoded.items

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = encoded[keyword]
    const others = decoded[keyword]

    if (Array.isArray(branches) && Array.isArray(others) && branches.length === others.length) {
      merged[keyword] = branches.map((branch, index) => mergeWire(branch, others[index]) ?? branch)
    }
  }

  return merged
}

/** The schema a JSON client sends for an input: its wire format, filled in where a validator decodes from anything. */
function inputDocument(schema: EndpointSchema): SchemaDocument {
  const encoded = documentOf(schema)
  const decoded = documentOf(S.toType(schema))
  const definitions: Record<string, JsonObject> = {}

  for (const [name, definition] of Object.entries(encoded.definitions)) {
    const merged = mergeWire(definition, decoded.definitions[name])
    definitions[name] = isObject(merged) ? merged : definition
  }

  const merged = mergeWire(encoded.schema, decoded.schema)

  return { schema: isObject(merged) ? merged : encoded.schema, definitions: { ...decoded.definitions, ...definitions } }
}

/** Collects every document's definitions as the description's components, renaming one whose name another took. */
class Components {
  readonly schemas: Record<string, JsonObject> = { ErrorResponse: documentOf(ErrorResponse).schema }

  /** The document's schema, its `$ref`s pointing at the components. */
  add(document: SchemaDocument): JsonObject {
    const renamed = new Map<string, string>()

    for (const [name, definition] of Object.entries(document.definitions)) {
      let target = name
      let suffix = 2

      while (this.schemas[target] !== undefined && JSON.stringify(this.schemas[target]) !== JSON.stringify(definition)) {
        target = `${name}${suffix}`
        suffix += 1
      }

      renamed.set(name, target)
    }

    const point = (value: JsonValue): JsonValue => {
      if (Array.isArray(value)) return value.map(point)
      if (!isObject(value)) return value

      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (key === '$ref' && typeof item === 'string' && item.startsWith('#/$defs/')) {
          const name = decodeURIComponent(item.slice('#/$defs/'.length))

          return [key, `#/components/schemas/${encodeURIComponent(renamed.get(name) ?? name)}`]
        }

        return [key, point(item)]
      }))
    }

    for (const [name, definition] of Object.entries(document.definitions)) {
      const pointed = point(definition)
      this.schemas[renamed.get(name) ?? name] = isObject(pointed) ? pointed : definition
    }

    const schema = point(document.schema)

    return isObject(schema) ? schema : document.schema
  }
}

/** Each property of an object schema as an OpenAPI parameter in `location`. */
function parametersOf(schema: JsonObject, location: 'query' | 'header'): JsonValue[] {
  const properties = schema.properties
  const required = Array.isArray(schema.required) ? schema.required : []

  if (!isObject(properties)) return []

  return Object.entries(properties).map(([name, property]) => {
    const parameter: Record<string, JsonValue> = { name, in: location, required: required.includes(name), schema: property }

    if (isObject(property) && typeof property.description === 'string') parameter.description = property.description

    return parameter
  })
}

const json = (schema: JsonValue): JsonObject => ({ content: { 'application/json': { schema } } })

/** The envelope a declared failure answers with, its `body` one of the failures declared on its status. */
function failureEnvelope(bodies: ReadonlyArray<JsonValue>): JsonObject {
  return {
    allOf: [
      { $ref: '#/components/schemas/ErrorResponse' },
      { type: 'object', properties: { body: bodies.length === 1 ? bodies[0] : { oneOf: bodies } }, required: ['body'] },
    ],
  }
}

function operationOf(name: string, spec: EndpointSpec, path: string, components: Components): JsonObject {
  const pathParameters: JsonValue[] = [...path.matchAll(/\{([^}:]+)(?::[^}]+)?\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
  const queryParameters = spec.query === undefined ? [] : parametersOf(components.add(inputDocument(spec.query)), 'query')
  const headerParameters = spec.headers === undefined ? [] : parametersOf(components.add(inputDocument(spec.headers)), 'header')
  const responses: Record<string, JsonValue> = {}

  if (spec.success === undefined) {
    responses[String(spec.status ?? 204)] = { description: 'Success, with no body.' }
  } else {
    responses[String(spec.status ?? 200)] = { description: 'Success.', ...json(components.add(documentOf(spec.success))) }
  }

  for (const [status, declared] of Object.entries(spec.errors ?? {})) {
    const schemas = Array.isArray(declared) ? declared : [declared]
    const tags = schemas.map((schema) => schemaTag(schema)).join(', ')

    responses[status] = {
      description: tags,
      ...json(failureEnvelope(schemas.map((schema) => components.add(documentOf(schema))))),
    }
  }

  if ((spec.query !== undefined || spec.body !== undefined || spec.headers !== undefined) && responses['422'] === undefined) {
    responses['422'] = {
      description: 'The input does not validate: `errors` holds each invalid field’s message.',
      ...json({ $ref: '#/components/schemas/ErrorResponse' }),
    }
  }

  const operation: Record<string, JsonValue> = { operationId: name }

  if (spec.summary !== undefined) operation.summary = spec.summary
  operation.parameters = [...pathParameters, ...queryParameters, ...headerParameters]
  if (spec.body !== undefined) operation.requestBody = { required: true, ...json(components.add(inputDocument(spec.body))) }
  operation.responses = responses

  return operation
}

/** A tagged schema's `_tag`, for the description of the status it answers. */
function schemaTag(schema: EndpointSchema): string {
  const tag = documentOf(S.toType(schema))
  const definition = Object.values(tag.definitions)[0] ?? tag.schema
  const properties = definition.properties
  const literal = isObject(properties) && isObject(properties._tag) ? properties._tag.enum : undefined

  return Array.isArray(literal) && typeof literal[0] === 'string' ? literal[0] : 'Failure'
}

/**
 * Describe endpoints as an OpenAPI 3.1 document: each one's parameters, body,
 * success and declared failures, from its contract, with each operation named
 * by its key. Serve it from a route, or write it to a file in a build step.
 *
 * @example
 * routes.get(paths.openApi, action(json(openApi(endpoints, { title: 'Places API', version: '1' }))))
 */
export function openApi(endpoints: Readonly<Record<string, Endpoint>>, info: OpenApiInfo): JsonObject {
  const components = new Components()
  const paths: Record<string, Record<string, JsonValue>> = {}

  for (const [name, ep] of Object.entries(endpoints)) {
    const path = ep.path.replace(/\{([^}:]+):[^}]+\}/g, '{$1}')
    const operations = paths[path] ?? {}

    operations[ep.method] = operationOf(name, ep.spec, ep.path, components)
    paths[path] = operations
  }

  const described: Record<string, JsonValue> = { title: info.title, version: info.version }

  if (info.description !== undefined) described.description = info.description

  const document: Record<string, JsonValue> = { openapi: '3.1.0', info: described }

  if (info.servers !== undefined) document.servers = info.servers.map((url) => ({ url }))
  document.paths = paths
  document.components = { schemas: components.schemas }

  return document
}
