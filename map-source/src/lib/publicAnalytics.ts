"use client";

import type { PostHog } from "posthog-js";

export const PUBLIC_ANALYTICS_EVENT = "knok:public-analytics";

type PublicAnalyticsDetail = {
  event: string;
  route: string;
  properties: Record<string, string | number | boolean>;
};

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: (...args: unknown[]) => void;
  }
}

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || "G-PPJ6D8NBTQ";
const CLARITY_PROJECT_ID = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || "xjnqobcrqk";
const POSTHOG_PROJECT_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || "";
const POSTHOG_HOST = (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");

let initialization: Promise<void> | null = null;
let posthogClient: PostHog | null = null;
let enabled = false;
let capturedPagePath = "";

function appendScript(id: string, src: string): void {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.async = true;
  script.src = src;
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

function initializeGoogleAnalytics(): void {
  if (!GA_MEASUREMENT_ID) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || ((...args: unknown[]) => window.dataLayer?.push(args));
  window.gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  window.gtag("consent", "update", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "granted",
  });
  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
  });
  appendScript("knok-ga4", `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`);
}

function initializeClarity(): void {
  if (!CLARITY_PROJECT_ID || window.clarity) return;
  window.clarity = (...args: unknown[]) => {
    const clarity = window.clarity as ((...values: unknown[]) => void) & { q?: unknown[][] };
    clarity.q = clarity.q || [];
    clarity.q.push(args);
  };
  window.clarity("consentv2", {
    ad_Storage: "denied",
    analytics_Storage: "granted",
  });
  appendScript("knok-clarity", `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_PROJECT_ID)}`);
}

async function initializePostHog(): Promise<void> {
  if (!POSTHOG_PROJECT_TOKEN || posthogClient) return;
  const posthog = (await import("posthog-js")).default;
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: POSTHOG_HOST,
    ui_host: "https://app.posthog.com",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
    persistence: "localStorage+cookie",
    secure_cookie: true,
    respect_dnt: true,
  });
  posthog.opt_in_capturing();
  posthogClient = posthog;
}

export function initializePublicAnalytics(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  enabled = true;
  if (!initialization) {
    initialization = (async () => {
      initializeGoogleAnalytics();
      initializeClarity();
      await initializePostHog();
    })();
  }
  return initialization;
}

export function disablePublicAnalytics(): void {
  enabled = false;
  window.gtag?.("consent", "update", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  posthogClient?.opt_out_capturing();
  window.clarity?.("consentv2", {
    ad_Storage: "denied",
    analytics_Storage: "denied",
  });
  window.clarity?.("consent", false);
}

export function capturePublicAnalytics(detail: PublicAnalyticsDetail): void {
  if (!enabled || typeof window === "undefined") return;
  const pagePath = detail.route || window.location.pathname;
  const pageUrl = `${window.location.origin}${pagePath}`;
  const properties = { ...detail.properties, page_path: pagePath };

  if (detail.event === "page_view") {
    if (capturedPagePath === pagePath) return;
    capturedPagePath = pagePath;
    window.gtag?.("event", "page_view", {
      page_location: pageUrl,
      page_path: pagePath,
      page_title: document.title,
    });
    posthogClient?.capture("$pageview", { $current_url: pageUrl, ...properties });
  } else {
    window.gtag?.("event", detail.event, properties);
    posthogClient?.capture(detail.event, properties);
  }
  window.clarity?.("event", detail.event);
}
