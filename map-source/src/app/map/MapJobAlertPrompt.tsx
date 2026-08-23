"use client";

import { Bell, Check, Mail, X } from "lucide-react";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import styles from "./map.module.css";

const ALERT_API = process.env.NEXT_PUBLIC_MAP_ALERT_API
  || "https://focgeubdgfdglhsbgiqz.supabase.co/functions/v1/public-map-alerts";
const DISMISSED_KEY = "knok-map-alert-dismissed-at";
const SUBSCRIBED_KEY = "knok-map-alert-subscribed";
const DISMISSAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_OPEN_DELAY_MS = 14_000;

type PromptTrigger = "button" | "automatic";

function hasRecentDismissal(): boolean {
  try {
    const dismissedAt = Number(window.localStorage.getItem(DISMISSED_KEY) || 0);
    return dismissedAt > 0 && Date.now() - dismissedAt < DISMISSAL_WINDOW_MS;
  } catch {
    return false;
  }
}

function isSubscribed(): boolean {
  try {
    return window.localStorage.getItem(SUBSCRIBED_KEY) === "1";
  } catch {
    return false;
  }
}

export function MapJobAlertPrompt({
  roleTarget,
  searchQuery,
  engaged,
}: {
  roleTarget: string;
  searchQuery: string;
  engaged: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const emailInput = useRef<HTMLInputElement>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<PromptTrigger>("button");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(roleTarget);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(true);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    setHidden(isSubscribed());
  }, []);

  useEffect(() => {
    if (!role && roleTarget) setRole(roleTarget);
  }, [role, roleTarget]);

  useEffect(() => {
    if (!engaged || hidden || open || hasRecentDismissal()) return;
    let cancelled = false;
    let timer: number;
    const tryOpen = () => {
      if (cancelled) return;
      if (document.querySelector('[aria-label="Analytics preferences"]')) {
        timer = window.setTimeout(tryOpen, 5_000);
        return;
      }
      setTrigger("automatic");
      openedAt.current = Date.now();
      setOpen(true);
      track("map_alert_prompt_opened", { trigger: "automatic", role_present: Boolean(roleTarget) });
    };
    timer = window.setTimeout(tryOpen, AUTO_OPEN_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engaged, hidden, open, roleTarget]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => emailInput.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePrompt();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  // closePrompt is deliberately omitted: this effect only depends on whether
  // the dialog is mounted, and adding the render-local function causes churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openPrompt() {
    setTrigger("button");
    setError("");
    setStatus("idle");
    openedAt.current = Date.now();
    setOpen(true);
    track("map_alert_prompt_opened", { trigger: "button", role_present: Boolean(roleTarget) });
  }

  function closePrompt() {
    if (status === "submitting") return;
    setOpen(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {}
    track("map_alert_prompt_dismissed", { trigger, completed: status === "success" });
    window.setTimeout(() => triggerButton.current?.focus(), 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setStatus("error");
      setError("Enter a valid email address.");
      emailInput.current?.focus();
      return;
    }

    setStatus("submitting");
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(ALERT_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: normalizedEmail,
          city: "bengaluru",
          role_target: role.trim(),
          search_query: searchQuery.trim(),
          company: form.get("company") || "",
          started_at: openedAt.current,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "Could not save the alert right now");
      }
      setStatus("success");
      try {
        window.localStorage.setItem(SUBSCRIBED_KEY, "1");
        window.localStorage.removeItem(DISMISSED_KEY);
      } catch {}
      track("map_alert_submitted", { trigger, role_present: Boolean(role.trim()) });
    } catch (submissionError) {
      setStatus("error");
      setError(submissionError instanceof Error ? submissionError.message : "Could not save the alert right now.");
      track("map_alert_failed", { trigger, error_code: "capture_failed" });
    }
  }

  if (hidden && !open) return null;

  return (
    <>
      {!open ? (
        <button ref={triggerButton} type="button" className={styles.jobAlertTrigger} onClick={openPrompt} aria-label="Get Bengaluru job alerts">
          <Bell /><span>Job alerts</span>
        </button>
      ) : null}

      {open ? (
        <div className={styles.jobAlertBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closePrompt();
        }}>
          <section className={styles.jobAlertDialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
            <button type="button" className={styles.jobAlertClose} onClick={closePrompt} aria-label="Close job alerts"><X /></button>
            {status === "success" ? (
              <div className={styles.jobAlertSuccess}>
                <span><Check /></span>
                <p>YOU’RE ON THE LIST</p>
                <h2 id={titleId}>We’ll keep an eye on Bengaluru.</h2>
                <div id={descriptionId}>Your alert is saved. We’ll use this address only for relevant job-alert updates.</div>
                <button type="button" onClick={() => { setOpen(false); setHidden(true); }}>Back to the map</button>
              </div>
            ) : (
              <>
                <div className={styles.jobAlertIcon}><Mail /></div>
                <p className={styles.jobAlertEyebrow}>BENGALURU JOB ALERTS</p>
                <h2 id={titleId}>Don’t miss the next role.</h2>
                <p id={descriptionId} className={styles.jobAlertIntro}>Join Knok’s early alert list. We’ll notify you as relevant Bengaluru hiring updates become available.</p>
                <form onSubmit={submit} noValidate>
                  <label>
                    <span>Email address</span>
                    <input ref={emailInput} data-clarity-mask="true" type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-invalid={status === "error"} />
                  </label>
                  <label>
                    <span>Role or keyword <small>optional</small></span>
                    <input data-clarity-mask="true" type="text" name="role" value={role} onChange={(event) => setRole(event.target.value)} placeholder="e.g. Product Manager" maxLength={120} />
                  </label>
                  <label className={styles.jobAlertHoneypot} aria-hidden="true">
                    <span>Company</span><input type="text" name="company" tabIndex={-1} autoComplete="off" />
                  </label>
                  {error ? <p className={styles.jobAlertError} role="alert">{error}</p> : null}
                  <button type="submit" className={styles.jobAlertSubmit} disabled={status === "submitting"}>
                    {status === "submitting" ? "Saving…" : "Create my alert"}
                  </button>
                </form>
                <small className={styles.jobAlertFinePrint}>Free · No spam · Unsubscribe anytime</small>
              </>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
