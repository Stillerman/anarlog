import type { ErrorEvent, SeverityLevel } from "@sentry/react";

import { isUserError, isUserErrorEvent } from "@anlg/user-error";

type ErrorContextValue = null | boolean | number | string;
const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9_.:/-]{1,128}$/;
const SAFE_STACK_FUNCTION_RE = /^[a-zA-Z0-9_$.[\]<>-]{1,128}$/;
// Archived Sentry issue types. Local error logs stay; Sentry should not reopen
// or bill for issues that were already solved. Keep in sync with
// `IGNORED_ERROR_MARKERS` in crates/user-error/src/lib.rs.
const IGNORED_ERROR_MARKERS = [
  "[runbatch]",
  "post-stop transcript repair failed",
  "[audio-retention]",
  "batch transcription failed",
  "connect_async_failed",
  "acquired connection, but time to acquire exceeded",
  "slow statement",
  "samples_dropped",
  "mic_samples_dropped",
  "zoom_mic_usage_check_failed",
  "e2ee recovery key setup is required",
  "couldn't find callback id",
  "[sessionpersister]",
  "update_check_failed",
  "failed to check for updates",
  "failed_to_check_for_updates",
  "listen_ws_connect_failed",
  "listener_retry_failed",
  "failed to fetch remote connection ids",
];

function serializeForUserErrorMatch(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return `${value.name}: ${value.message} ${serializeForUserErrorMatch({ ...value })}`;
  }

  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function textMatchesMarkers(value: unknown, markers: readonly string[]) {
  const text = serializeForUserErrorMatch(value).toLowerCase();
  return markers.some((marker) => text.includes(marker));
}

function isIgnoredError(value: unknown): boolean {
  const text = serializeForUserErrorMatch(value);
  return (
    text.startsWith("[String(") ||
    text.startsWith("[Object {") ||
    textMatchesMarkers(text, IGNORED_ERROR_MARKERS)
  );
}

// Breadcrumbs are deliberately excluded: they outlive the failure that produced
// them and would suppress later, unrelated errors.
function isDroppedErrorEvent(event: ErrorEvent): boolean {
  const logger = typeof event.logger === "string" ? event.logger : undefined;
  if (
    logger &&
    (logger.startsWith("tauri_plugin_tracing") ||
      logger === "anarlog.webview.console" ||
      logger === "hyprnote.webview.console")
  ) {
    return true;
  }

  return (
    isUserErrorEvent(event) ||
    [event.message, event.logentry, event.exception, event.extra].some(
      isIgnoredError,
    )
  );
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_IDENTIFIER_RE.test(value)
    ? value
    : undefined;
}

function safeStackFunction(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_STACK_FUNCTION_RE.test(value)
    ? value
    : undefined;
}

export function operationalErrorMetadata(error: unknown) {
  if (!error || typeof error !== "object") {
    return { type: "Error" };
  }

  const record = error as Record<string, unknown>;
  const statusValue = record.status ?? record.statusCode;
  const status =
    typeof statusValue === "number" &&
    Number.isInteger(statusValue) &&
    statusValue >= 100 &&
    statusValue <= 599
      ? statusValue
      : undefined;

  return {
    type: safeIdentifier(record.name) ?? "Error",
    code: safeIdentifier(record.code),
    stage: safeIdentifier(record.stage),
    status,
  };
}

export function normalizeOperationalError(
  error: unknown,
  operation: string,
): Error {
  const normalized = new Error(`${operation} failed`);
  const metadata = operationalErrorMetadata(error);
  normalized.name = metadata.type;

  return normalized;
}

const SAFE_TAGS = new Set([
  "anarlog.error.stage",
  "anarlog.operation",
  "anarlog.surface",
  "error.code",
  "error.type",
  "http.response.status_code",
  "service.name",
  "service.namespace",
]);

type ErrorException = NonNullable<
  NonNullable<ErrorEvent["exception"]>["values"]
>[number];
type ErrorStacktrace = NonNullable<ErrorException["stacktrace"]>;

function sanitizeStacktrace(stacktrace: ErrorStacktrace) {
  stacktrace.frames = stacktrace.frames?.map((frame) => ({
    colno: frame.colno,
    filename: "source",
    function: safeStackFunction(frame.function),
    in_app: frame.in_app,
    lineno: frame.lineno,
  }));
  return stacktrace;
}

export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent | null {
  if (isDroppedErrorEvent(event)) return null;

  delete event.user;
  delete event.request;
  delete event.contexts;
  delete event.extra;
  delete event.message;
  delete event.logentry;
  delete event.transaction;
  event.tags = Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(
      ([key, value]) =>
        SAFE_TAGS.has(key) &&
        (typeof value === "number" || safeIdentifier(value) !== undefined),
    ),
  );
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => {
      const sanitized = {
        ...exception,
        value: exception.type ? `${exception.type} captured` : "Error captured",
      };
      delete sanitized.module;
      if (sanitized.stacktrace) {
        sanitized.stacktrace = sanitizeStacktrace(sanitized.stacktrace);
      }
      if (sanitized.mechanism) {
        const original = sanitized.mechanism;
        sanitized.mechanism = {
          type: safeIdentifier(original.type) ?? "generic",
          ...(original.handled === undefined
            ? {}
            : { handled: original.handled }),
          ...(original.synthetic === undefined
            ? {}
            : { synthetic: original.synthetic }),
        };
      }
      return sanitized;
    });
  }
  event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({
    category: breadcrumb.category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    type: breadcrumb.type,
  }));

  return event;
}

// Keep local error handling and the sanitizers used by callers, but no reporter,
// replay recorder, account identity, or telemetry transport is initialized.
export function initializeErrorReporting() {}
export function setSessionReplayAnalyticsEnabled(_enabled: boolean) {}
export async function setErrorReportingEnabled(_enabled: boolean) {}
export function reportCaughtReactError(error: unknown) {
  if (!isUserError(error) && !isIgnoredError(error))
    console.error("React error", operationalErrorMetadata(error));
}
export function captureOperationalError(
  error: unknown,
  {
    operation,
  }: {
    operation: string;
    level?: SeverityLevel;
    tags?: Record<string, ErrorContextValue>;
    context?: Record<string, ErrorContextValue>;
  },
) {
  if (!isUserError(error) && !isIgnoredError(error))
    console.error(operation, operationalErrorMetadata(error));
}
export function setErrorReportingUser(_userId: string | null) {}
