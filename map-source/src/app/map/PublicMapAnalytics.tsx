"use client";

import { useEffect } from "react";
import { hasAnalyticsConsent, setAnalyticsConsent, track, trackOnce } from "@/lib/analytics";
import {
  capturePublicAnalytics,
  initializePublicAnalytics,
  PUBLIC_ANALYTICS_EVENT,
} from "@/lib/publicAnalytics";

type ConsentChoice = "accepted" | "declined" | null;

const LEGACY_CONSENT_KEY = "knok_cookie_consent";

function storedChoice(): ConsentChoice {
  try {
    if (hasAnalyticsConsent()) return "accepted";
    if (window.localStorage.getItem("knok-analytics-consent") === "0") return "declined";
    const legacy = window.localStorage.getItem(LEGACY_CONSENT_KEY);
    return legacy === "accepted" || legacy === "declined" ? legacy : null;
  } catch {
    return null;
  }
}

export function PublicMapAnalytics({ totalCompanies }: { totalCompanies: number }) {
  useEffect(() => {
    const onAnalytics = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail) capturePublicAnalytics(detail);
    };
    window.addEventListener(PUBLIC_ANALYTICS_EVENT, onAnalytics);

    // The map no longer presents a choice banner. Keep an explicit historic
    // opt-out intact, but enable the configured product analytics for every
    // other visitor so GA4, Clarity, PostHog and the event stream all agree.
    if (storedChoice() !== "declined") {
      setAnalyticsConsent(true);
      void initializePublicAnalytics().then(() => {
        track("page_view");
        trackOnce("map_viewed", { city: "bengaluru", total: totalCompanies });
      });
    }
    return () => window.removeEventListener(PUBLIC_ANALYTICS_EVENT, onAnalytics);
  }, [totalCompanies]);

  return null;
}
