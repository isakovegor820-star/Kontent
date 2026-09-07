import type { Integration } from '@sentry/core';
export function scrubTelemetryText(value: string): string;
export function scrubTelemetry<T>(value: T, seen?: WeakSet<object>): T;
export function telemetryScrubIntegration(): Integration;
