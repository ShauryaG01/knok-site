"use client";

/**
 * Consent-gated, first-party analytics client.
 *
 * Events are allowlisted, queued locally before transport, deduplicated by a
 * stable UUID and accepted by the same-origin API. The API is authoritative and
 * mirrors to PostHog through a durable outbox.
 */

const CONSENT_KEY = "knok-analytics-consent";
const DISTINCT_KEY = "knok-analytics-id";
const ONCE_PREFIX = "knok-evt-once:";
const SESSION_KEY = "knok-analytics-session";
const QUEUE_KEY = "knok-analytics-queue-v3";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_QUEUE_SIZE = 100;
const PUBLIC_ANALYTICS_EVENT = "knok:public-analytics";

export type AnalyticsEvent =
  | "signup"
  | "resume_uploaded"
  | "first_match_view"
  | "onboarding_completed"
  | "job_saved"
  | "role_selected"
  | "hiring_team_requested"
  | "hiring_team_shown"
  | "contact_selected"
  | "draft_viewed"
  | "draft_edited"
  | "draft_approved"
  | "email_revealed"
  | "outreach_sent"
  | "send_queued"
  | "send_failed"
  | "first_send"
  | "gmail_connect_started"
  | "gmail_connect_failed"
  | "gmail_connected"
  | "first_reply"
  | "checkout_started"
  | "checkout_failed"
  | "checkout_paid"
  | "paid"
  | "consent_changed"
  | "page_view"
  | "job_view"
  | "job_search"
  | "empty_results"
  | "apply_path_previewed"
  | "apply_handoff"
  | "apply_submitted"
  | "external_job_opened"
  | "founder_call_clicked"
  | "map_viewed"
  | "map_filter_applied"
  | "map_company_opened"
  | "map_job_opened"
  | "map_opportunity_clicked"
  | "map_navigation_clicked"
  | "map_share_clicked"
  | "map_feedback_clicked"
  | "map_alert_prompt_opened"
  | "map_alert_prompt_dismissed"
  | "map_alert_submitted"
  | "map_alert_failed"
  | "action_error";

const EVENT_PROPERTIES: Record<AnalyticsEvent, ReadonlySet<string>> = {
  signup: new Set(["method", "source", "campaign", "medium", "content"]),
  resume_uploaded: new Set(["file_type", "size_bucket"]),
  first_match_view: new Set(["total"]),
  onboarding_completed: new Set(),
  job_saved: new Set(["job_id"]),
  role_selected: new Set(["job_id", "company_canonical_id", "surface"]),
  hiring_team_requested: new Set(["job_id", "surface"]),
  hiring_team_shown: new Set(["job_id", "contacts", "source"]),
  contact_selected: new Set(["job_id", "contact_rank", "contact_role"]),
  draft_viewed: new Set(["job_id", "channel"]),
  draft_edited: new Set(["job_id", "channel"]),
  draft_approved: new Set(["job_id", "channel"]),
  email_revealed: new Set(["contacts"]),
  outreach_sent: new Set(["engine", "has_followups"]),
  send_queued: new Set(["engine", "has_followups", "recipient_count"]),
  send_failed: new Set(["engine", "error_code"]),
  first_send: new Set(["engine", "has_followups", "recipient_count"]),
  gmail_connect_started: new Set(["provider", "surface"]),
  gmail_connect_failed: new Set(["provider", "error_code"]),
  gmail_connected: new Set(["provider"]),
  first_reply: new Set(["provider"]),
  checkout_started: new Set(["plan", "provider", "upgrade"]),
  checkout_failed: new Set(["plan", "provider", "error_code"]),
  checkout_paid: new Set(["plan", "provider", "upgrade"]),
  paid: new Set(["plan", "upgrade"]),
  consent_changed: new Set(["analytics_enabled", "marketing_enabled"]),
  page_view: new Set(),
  job_view: new Set(["job_id", "company_canonical_id"]),
  job_search: new Set(["query_length", "result_count", "filters_count"]),
  empty_results: new Set(["query_length", "filters_count"]),
  apply_path_previewed: new Set(["capability", "engine", "missing_count"]),
  apply_handoff: new Set(["engine", "missing_count"]),
  apply_submitted: new Set(["engine"]),
  external_job_opened: new Set(["job_id", "surface"]),
  founder_call_clicked: new Set(["placement"]),
  map_viewed: new Set(["city", "total"]),
  map_filter_applied: new Set(["city", "filter_kind", "result_count"]),
  map_company_opened: new Set(["company_slug", "area", "sector"]),
  map_job_opened: new Set(["job_id", "company_canonical_id"]),
  map_opportunity_clicked: new Set(["company_slug", "role", "job_id"]),
  map_navigation_clicked: new Set(["destination", "role"]),
  map_share_clicked: new Set(["city", "view", "filters_count"]),
  map_feedback_clicked: new Set(["mode"]),
  map_alert_prompt_opened: new Set(["trigger", "role_present"]),
  map_alert_prompt_dismissed: new Set(["trigger", "completed"]),
  map_alert_submitted: new Set(["trigger", "role_present"]),
  map_alert_failed: new Set(["trigger", "error_code"]),
  action_error: new Set(["action", "status", "error_code"]),
};

type QueuedEvent = {
  event_id: string;
  event: AnalyticsEvent;
  route: string;
  session_id: string;
  properties: Record<string, string | number | boolean>;
};

let analyticsAuthToken = "";
let flushing = false;

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function setAnalyticsAuthToken(token: string | null): void {
  analyticsAuthToken = token || "";
  if (analyticsAuthToken && hasAnalyticsConsent()) void flushAnalyticsQueue();
}

export function setAnalyticsConsent(consented: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, consented ? "1" : "0");
    if (!consented) {
      window.localStorage.removeItem(QUEUE_KEY);
      resetAnalyticsIdentity();
    } else if (analyticsAuthToken) {
      void flushAnalyticsQueue();
    }
  } catch {}
}

export function resetAnalyticsIdentity(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DISTINCT_KEY);
    window.localStorage.removeItem(QUEUE_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

export function hasAnalyticsConsent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function identify(userId: string): void {
  if (typeof window === "undefined" || !hasAnalyticsConsent()) return;
  try {
    window.localStorage.setItem(DISTINCT_KEY, userId);
  } catch {}
}

function distinctId(): string {
  try {
    let id = window.localStorage.getItem(DISTINCT_KEY);
    if (!id) {
      id = `anon-${uuid()}`;
      window.localStorage.setItem(DISTINCT_KEY, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

function sessionId(): string {
  try {
    const now = Date.now();
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const stored = raw ? JSON.parse(raw) as { id?: string; touched_at?: number } : {};
    const expired = !stored.id || !stored.touched_at || now - stored.touched_at > SESSION_TIMEOUT_MS;
    const session = { id: expired ? `s-${uuid()}` : stored.id!, touched_at: now };
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session.id;
  } catch {
    return "";
  }
}

function safeProperties(
  event: AnalyticsEvent,
  properties: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const allowed = EVENT_PROPERTIES[event];
  const clean: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = properties[key];
    if (typeof value === "string") {
      const bounded = value.slice(0, 80);
      const lower = bounded.toLowerCase();
      if (bounded.includes("@") || lower.includes("http://") || lower.includes("https://")) continue;
      clean[key] = bounded;
    } else if (typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    }
  }
  return clean;
}

function readQueue(): QueuedEvent[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(value) ? value.slice(-MAX_QUEUE_SIZE) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedEvent[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_SIZE)));
  } catch {}
}

function enqueue(event: QueuedEvent): void {
  const queue = readQueue();
  if (!queue.some((queued) => queued.event_id === event.event_id)) queue.push(event);
  writeQueue(queue);
}

export async function flushAnalyticsQueue(): Promise<void> {
  if (
    flushing
    || typeof window === "undefined"
    || !hasAnalyticsConsent()
    || !analyticsAuthToken
  ) return;
  flushing = true;
  try {
    while (readQueue().length > 0) {
      const next = readQueue()[0];
      let response: Response;
      try {
        response = await fetch("/api/me/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${analyticsAuthToken}`,
          },
          keepalive: true,
          body: JSON.stringify(next),
        });
      } catch {
        break;
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 403) {
          writeQueue(readQueue().filter((queued) => queued.event_id !== next.event_id));
          continue;
        }
        break;
      }
      // Re-read before removal: another event can be queued while this request
      // is in flight. Mutating a stale snapshot would silently drop it.
      writeQueue(readQueue().filter((queued) => queued.event_id !== next.event_id));
    }
  } finally {
    flushing = false;
    if (readQueue().length > 0 && hasAnalyticsConsent() && analyticsAuthToken) {
      void flushAnalyticsQueue();
    }
  }
}

export function track(event: AnalyticsEvent, properties: Record<string, unknown> = {}): void {
  if (typeof window === "undefined" || !hasAnalyticsConsent()) return;
  const queued: QueuedEvent = {
    event_id: uuid(),
    event,
    route: window.location.pathname,
    session_id: sessionId(),
    properties: safeProperties(event, properties),
  };
  enqueue(queued);
  window.dispatchEvent(new CustomEvent(PUBLIC_ANALYTICS_EVENT, {
    detail: {
      event: queued.event,
      route: queued.route,
      properties: queued.properties,
    },
  }));
  void flushAnalyticsQueue();
}

export function trackOnce(event: AnalyticsEvent, properties: Record<string, unknown> = {}): void {
  if (typeof window === "undefined" || !hasAnalyticsConsent()) return;
  try {
    const key = `${ONCE_PREFIX}${distinctId()}:${event}`;
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    return;
  }
  track(event, properties);
}
