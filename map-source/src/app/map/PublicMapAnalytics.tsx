"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { hasAnalyticsConsent, setAnalyticsConsent, track, trackOnce } from "@/lib/analytics";
import {
  capturePublicAnalytics,
  disablePublicAnalytics,
  initializePublicAnalytics,
  PUBLIC_ANALYTICS_EVENT,
} from "@/lib/publicAnalytics";
import styles from "./map.module.css";

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

function saveLegacyChoice(choice: Exclude<ConsentChoice, null>): void {
  try {
    window.localStorage.setItem(LEGACY_CONSENT_KEY, choice);
  } catch {}
}

export function PublicMapAnalytics({ totalCompanies }: { totalCompanies: number }) {
  const [choice, setChoice] = useState<ConsentChoice>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onAnalytics = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail) capturePublicAnalytics(detail);
    };
    window.addEventListener(PUBLIC_ANALYTICS_EVENT, onAnalytics);

    const existing = storedChoice();
    setChoice(existing);
    setReady(true);
    if (existing === "accepted") {
      setAnalyticsConsent(true);
      void initializePublicAnalytics().then(() => {
        track("page_view");
        trackOnce("map_viewed", { city: "bengaluru", total: totalCompanies });
      });
    }
    return () => window.removeEventListener(PUBLIC_ANALYTICS_EVENT, onAnalytics);
  }, [totalCompanies]);

  function choose(next: Exclude<ConsentChoice, null>) {
    saveLegacyChoice(next);
    setChoice(next);
    if (next === "accepted") {
      setAnalyticsConsent(true);
      void initializePublicAnalytics().then(() => {
        track("consent_changed", { analytics_enabled: true, marketing_enabled: false });
        track("page_view");
        trackOnce("map_viewed", { city: "bengaluru", total: totalCompanies });
      });
    } else {
      setAnalyticsConsent(false);
      disablePublicAnalytics();
    }
  }

  if (!ready || choice !== null) return null;

  return (
    <aside className={styles.analyticsConsent} aria-label="Analytics preferences">
      <div>
        <strong>Help us improve the map</strong>
        <p>
          Optional analytics show us which searches and map interactions work. Inputs are masked and we do not sell personal data. Read our{" "}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      </div>
      <div className={styles.analyticsConsentActions}>
        <button type="button" onClick={() => choose("declined")}>Essential only</button>
        <button type="button" onClick={() => choose("accepted")}>Allow analytics</button>
      </div>
    </aside>
  );
}

