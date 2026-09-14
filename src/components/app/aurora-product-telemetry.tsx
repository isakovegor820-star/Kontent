"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import {
  auroraProductEventWireDraft,
  auroraSectionForPath,
  emitAuroraProductEvent,
  installAuroraTelemetrySink,
  primaryAuroraFeature,
} from "@/lib/aurora-product-telemetry";
import type { AuroraProductEventDraft } from "@/lib/product-event-contract.mjs";

const SESSION_KEY = "aurora.product.session.v1";
const MAX_BATCH = 25;
const FLUSH_DELAY_MS = 500;
let lastNavigationAt = 0;

function sessionId(): string | null {
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (stored && /^[0-9a-f-]{36}$/iu.test(stored)) return stored;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return null;
  }
}

function device(): "desktop" | "mobile" | "tablet" | "unknown" {
  const width = window.innerWidth;
  if (!Number.isFinite(width) || width <= 0) return "unknown";
  if (width < 640) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

function appVersion(): string | null {
  const raw = process.env.NEXT_PUBLIC_AURORA_APP_VERSION?.trim().toLowerCase();
  return raw && /^[a-z0-9][a-z0-9_.:-]{0,63}$/u.test(raw) ? raw : null;
}

function pageDuration(): number | null {
  if (lastNavigationAt > 0) return Math.max(0, Math.min(3_600_000, Math.round(performance.now() - lastNavigationAt)));
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return navigation && Number.isFinite(navigation.domContentLoadedEventEnd)
    ? Math.max(0, Math.min(3_600_000, Math.round(navigation.domContentLoadedEventEnd)))
    : null;
}

function explicitEvent(target: Element, sectionId: NonNullable<ReturnType<typeof auroraSectionForPath>>) {
  const action = target.getAttribute("data-aurora-action");
  if (!action) return;
  const featureId = target.getAttribute("data-aurora-feature") || primaryAuroraFeature(sectionId);
  const version = appVersion();
  emitAuroraProductEvent({
    sectionId,
    featureId,
    action,
    stage: "started",
    outcome: "pending",
    durationMs: null,
    errorCode: null,
    requestId: null,
    operationId: null,
    sessionId: sessionId(),
    safeContext: {
      device: device(),
      source: "ui",
      operationKind: "user_action",
      ...(version ? { appVersion: version } : {}),
    },
  });
}

export function AuroraProductTelemetry() {
  const pathname = usePathname();
  const queueRef = useRef<AuroraProductEventDraft[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      const events = queueRef.current.splice(0, MAX_BATCH);
      if (events.length === 0) return;
      void fetch("/api/product-events", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: events.map(auroraProductEventWireDraft) }),
        keepalive: true,
      }).catch(() => undefined);
      if (queueRef.current.length > 0) timerRef.current = window.setTimeout(flush, FLUSH_DELAY_MS);
    };
    const uninstall = installAuroraTelemetrySink((event) => {
      queueRef.current.push(event);
      if (event.important || queueRef.current.length >= MAX_BATCH) flush();
      else if (timerRef.current === null) timerRef.current = window.setTimeout(flush, FLUSH_DELAY_MS);
    });
    return () => {
      uninstall();
      flush();
    };
  }, []);

  useEffect(() => {
    const sectionId = auroraSectionForPath(pathname);
    if (!sectionId) return;
    const version = appVersion();
    emitAuroraProductEvent({
      sectionId,
      featureId: primaryAuroraFeature(sectionId),
      action: "loaded",
      stage: "completed",
      outcome: "success",
      durationMs: pageDuration(),
      errorCode: null,
      requestId: null,
      operationId: null,
      sessionId: sessionId(),
      safeContext: {
        device: device(),
        source: "ui",
        operationKind: "page_load",
        ...(version ? { appVersion: version } : {}),
      },
    });
    lastNavigationAt = 0;
  }, [pathname]);

  useEffect(() => {
    const sectionId = auroraSectionForPath(pathname);
    if (!sectionId) return;
    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest("[data-aurora-action],a[href^='/app']") : null;
      if (!element) return;
      if (element.matches("a[href^='/app']")) lastNavigationAt = performance.now();
      if (element.hasAttribute("data-aurora-action")) explicitEvent(element, sectionId);
    };
    const onError = () => {
      emitAuroraProductEvent({
        sectionId,
        featureId: primaryAuroraFeature(sectionId),
        action: "loaded",
        stage: "failed",
        outcome: "failure",
        durationMs: null,
        errorCode: "ui_runtime_error",
        requestId: null,
        operationId: null,
        sessionId: sessionId(),
        safeContext: { device: device(), source: "ui", operationKind: "page_runtime" },
      });
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [pathname]);

  return null;
}
