// Public surface of the client library.
export { FragDenStaatClient, type AutocompleteItem } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  isBidiControl,
  isTransientNetworkError,
  cleanDetail,
  decodeBody,
  responseShapeProblem,
  MAX_DETAIL_LENGTH,
  type ResponseShape,
  sanitizeServerText,
  type EngineOptions,
  type RawResponse,
} from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue, QueryPrimitive } from "./query.js";
export {
  FdsError,
  FdsApiError,
  FdsNetworkError,
  FdsParseError,
  FdsValidationError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
export {
  amountProblem,
  assertValid,
  assertNonBlankParams,
  baseUrlProblem,
  baseUrlSpaceProblem,
  booleanProblem,
  headerValueProblem,
  idFilterProblem,
  isBlank,
  nonBlankProblem,
  normalizeIdFilter,
  normalizeResourceId,
  oneOfProblem,
  pointProblem,
  queryTextProblem,
  resourceIdProblem,
  validateBaseUrl,
  validateParams,
  type ParamRules,
  type Problem,
} from "./validate.js";
export * from "./types.js";
export * from "./params.js";
export * from "./enums.js";
