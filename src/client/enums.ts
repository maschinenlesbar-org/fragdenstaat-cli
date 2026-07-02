// Domain enum value sets for the FragDenStaat.de API. Each const array doubles as
// a runtime CLI choice validator and as a TS union type. Values are taken from the
// upstream OpenAPI schema (drf-spectacular) and confirmed against the live API.

/**
 * The lifecycle status of an FOI request (`FoiRequest.status`). See GLOSSARY.md
 * for what each state means.
 */
export const RequestStatusValues = [
  "awaiting_user_confirmation",
  "publicbody_needed",
  "awaiting_publicbody_confirmation",
  "awaiting_response",
  "awaiting_classification",
  "asleep",
  "resolved",
] as const;
export type RequestStatus = (typeof RequestStatusValues)[number];

/**
 * How a request was ultimately resolved (`FoiRequest.resolution`). Only set once
 * the request reaches the `resolved` status.
 */
export const RequestResolutionValues = [
  "successful",
  "partially_successful",
  "not_held",
  "refused",
  "user_withdrew_costs",
  "user_withdrew",
] as const;
export type RequestResolution = (typeof RequestResolutionValues)[number];

/** The transport a message used (`FoiMessage.kind`). */
export const MessageKindValues = [
  "email",
  "post",
  "fax",
  "upload",
  "phone",
  "visit",
  "import",
] as const;
export type MessageKind = (typeof MessageKindValues)[number];

/** The administrative level of a geographic region (`GeoRegion.kind`). */
export const GeoRegionKindValues = [
  "country",
  "state",
  "admin_district",
  "district",
  "admin_cooperation",
  "municipality",
  "borough",
  "zipcode",
  "admin_court_jurisdiction",
] as const;
export type GeoRegionKind = (typeof GeoRegionKindValues)[number];

/** Implementation status of a coalition-agreement promise (`GovernmentPlan.status`). */
export const GovernmentPlanStatusValues = [
  "not_started",
  "started",
  "partially_implemented",
  "implemented",
  "deferred",
] as const;
export type GovernmentPlanStatus = (typeof GovernmentPlanStatusValues)[number];
