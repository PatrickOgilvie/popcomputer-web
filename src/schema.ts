/** Common Effect Schema validators for web requests. */

// Schema Validators (Effect Schema based)
export {
  // Re-export Schema namespace
  S,
  // String types
  trimmed,
  nullableString,
  optionalString,
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
  // Utility
  nullable,
  filled,
  excludeIf,
} from './effect/schema.js'

// Validation Helpers
export {
  getValidationData,
  formatSchemaErrors,
  createBodyParseValidationError,
  validate,
  validateUnknown,
  validateRequest,
  asValidated,
  asTrusted,
  type Validated,
  type Trusted,
  type RequestValidationSource,
  type RequestValidationProfile,
  type RequestValidationConflict,
  type RequestValidationOptions,
  type RequestValidationConfig,
} from './effect/validation.js'
