/**
 * `@popcomputer/web/schema`: Effect Schema validators for request input.
 *
 * They accept form posts as well as JSON. Validate with `validateRequest` from
 * `@popcomputer/web/effect`.
 */

// Schema Validators (Effect Schema based)
export {
  // String types
  trimmed,
  nullableString,
  requiredString,
  required,
  alpha,
  alphaDash,
  alphaNum,
  startsWith,
  endsWith,
  lowercase,
  uppercase,
  // Numeric types
  coercedNumber,
  positiveInt,
  nonNegativeInt,
  parsePositiveInt,
  between,
  digits,
  digitsBetween,
  gt,
  gte,
  lt,
  lte,
  multipleOf,
  // Boolean types
  coercedBoolean,
  checkbox,
  accepted,
  declined,
  // Date types
  coercedDate,
  nullableDate,
  after,
  afterOrEqual,
  before,
  beforeOrEqual,
  // Array types
  ensureArray,
  distinct,
  minItems,
  maxItems,
  // Enum/In rules
  inArray,
  notIn,
  // Format types
  email,
  nullableEmail,
  url,
  nullableUrl,
  uuid,
  nullableUuid,
  ip,
  ipv4,
  ipv6,
  macAddress,
  jsonString,
  // Confirmation
  confirmed,
  // Size rules
  size,
  min,
  max,
  // Password
  password,
  // Files
  upload,
  nullableUpload,
  type UploadOptions,
  // Utility
  nullable,
  filled,
  excludeIf,
} from './effect/schema.js'

// Schemas of Drizzle tables' rows
export {
  columnsOf,
  tableSchema,
  type ColumnOverrides,
  type ColumnsOf,
  type TableFields,
  type TableSchemaFields,
} from './effect/table-schema.js'

// The JSON body every failure answers a JSON client with, for clients to decode
export { ErrorResponse, errorResponseWith } from './effect/error-response.js'

// Media types a browser runs script in, which upload families leave out
export { ACTIVE_CONTENT_TYPES } from './effect/schema.js'
