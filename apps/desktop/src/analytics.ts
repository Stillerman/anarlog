import type { JsonValue } from "@anlg/plugin-analytics";

// Telemetry is permanently unavailable in this fork.
export function trackAnalyticsEvent(
  _event: string,
  _properties: Record<string, JsonValue> = {},
) {}
