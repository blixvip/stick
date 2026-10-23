/** Presentation metadata is separate from server codes and stored support data. */
export const SUPPORT_CATEGORIES_KEYS = Object.freeze({
  "bug": "supportMessages.categories.bug",
  "performance": "supportMessages.categories.performance",
  "idea": "supportMessages.categories.idea",
  "other": "supportMessages.categories.other"
});
export const SUPPORT_CATEGORIES = Object.freeze(Object.fromEntries(Object.entries(SUPPORT_CATEGORIES_KEYS).map(([id,messageKey])=>[id,{messageKey}])));
export const SUPPORT_STATUSES_KEYS = Object.freeze({
  "new": "supportMessages.statuses.new",
  "triaged": "supportMessages.statuses.triaged",
  "waiting": "supportMessages.statuses.waiting",
  "in_progress": "supportMessages.statuses.inProgress",
  "resolved": "supportMessages.statuses.resolved",
  "closed": "supportMessages.statuses.closed",
  "spam": "supportMessages.statuses.spam"
});
export const SUPPORT_STATUSES = Object.freeze(Object.fromEntries(Object.entries(SUPPORT_STATUSES_KEYS).map(([id,messageKey])=>[id,{messageKey}])));
export const SUPPORT_PRIORITIES_KEYS = Object.freeze({
  "low": "supportMessages.priorities.low",
  "normal": "supportMessages.priorities.normal",
  "high": "supportMessages.priorities.high",
  "urgent": "supportMessages.priorities.urgent"
});
export const SUPPORT_PRIORITIES = Object.freeze(Object.fromEntries(Object.entries(SUPPORT_PRIORITIES_KEYS).map(([id,messageKey])=>[id,{messageKey}])));
export const SUPPORT_ERRORS_KEYS = Object.freeze({
  "support_paused": "supportMessages.errors.supportPaused",
  "support_capacity_reached": "supportMessages.errors.supportCapacityReached",
  "support_budget_reached": "supportMessages.errors.supportBudgetReached",
  "rate_limited": "supportMessages.errors.rateLimited",
  "actor_limit_reached": "supportMessages.errors.actorLimitReached",
  "not_found": "supportMessages.errors.notFound",
  "report_locked": "supportMessages.errors.reportLocked",
  "stale_report": "supportMessages.errors.staleReport",
  "attachment_storage_unavailable": "supportMessages.errors.attachmentStorageUnavailable",
  "attachment_capacity_reached": "supportMessages.errors.attachmentCapacityReached",
  "attachment_in_progress": "supportMessages.errors.attachmentInProgress",
  "invalid_file": "supportMessages.errors.invalidFile",
  "media_source_large": "supportMessages.errors.mediaSourceLarge",
  "media_output_large": "supportMessages.errors.mediaOutputLarge",
  "media_decode_failed": "supportMessages.errors.mediaDecodeFailed",
  "video_too_long": "supportMessages.errors.videoTooLong",
  "video_compression_unavailable": "supportMessages.errors.videoCompressionUnavailable",
  "invalid_report": "supportMessages.errors.invalidReport",
  "invalid_message": "supportMessages.errors.invalidMessage",
  "authentication_required": "supportMessages.errors.authenticationRequired",
  "payload_too_large": "supportMessages.errors.payloadTooLarge",
  "service_unavailable": "supportMessages.errors.serviceUnavailable"
});
export function supportErrorMessage(error) { return {messageKey:SUPPORT_ERRORS_KEYS[error?.code || error?.message] || 'supportMessages.errors.requestFailed'}; }
export const supportLiveMessageKeys=Object.freeze({'Manual refresh':'supportMessages.live.manual','Connecting…':'supportMessages.live.connecting','Reconnecting…':'supportMessages.live.reconnecting','Live':'supportMessages.live.connected'});
