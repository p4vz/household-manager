"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES, type NotificationPrefs, type NotificationType } from "@/core/push/types";

export type PushDevice = { id: string; label: string; createdAt: string; lastOkAt: string | null; endpoint: string };

type Result = { ok: boolean; message: string };
type Actions = {
  subscribe: (input: { endpoint: string; p256dh: string; auth: string; label: string }) => Promise<Result>;
  unsubscribe: (input: { endpoint?: string; id?: string }) => Promise<void>;
  savePrefs: (input: NotificationPrefs) => Promise<void>;
  test: (input: Record<string, never>) => Promise<Result>;
};

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows computer";
  return "This device";
}

const b64u = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");

function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const s = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Support = "checking" | "ok" | "ios-install" | "none" | "blocked";

function detectSupport(): Support {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return ios && !standalone ? "ios-install" : "none";
  return Notification.permission === "denied" ? "blocked" : "ok";
}
const noSubscribe = () => () => undefined;

/** Settings → Phone notifications. Each member has their own devices and choices. */
export function PushSettings({ publicKey, devices, prefs, actions }: { publicKey: string; devices: PushDevice[]; prefs: NotificationPrefs; actions: Actions }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const detected = useSyncExternalStore(noSubscribe, detectSupport, (): Support => "checking");
  const [denied, setDenied] = useState(false);
  const support: Support = denied ? "blocked" : detected;
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setThisEndpoint(sub?.endpoint ?? null))
      .catch(() => undefined);
  }, []);

  const registered = thisEndpoint !== null && devices.some((d) => d.endpoint === thisEndpoint);

  const turnOn = () =>
    start(async () => {
      setNote(null);
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setDenied(permission === "denied");
          setNote("Notifications were not allowed.");
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        const wanted = keyBytes(publicKey);
        const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
        if (sub && current && current.join() !== wanted.join()) {
          await sub.unsubscribe();
          sub = null;
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
        const r = await actions.subscribe({ endpoint: sub.endpoint, p256dh: b64u(sub.getKey("p256dh")), auth: b64u(sub.getKey("auth")), label: deviceLabel() });
        setThisEndpoint(sub.endpoint);
        setNote(r.message);
      } catch (err) {
        setNote(err instanceof Error && /service worker/i.test(err.message) ? "Open the installed app (or reload) and try again." : "Could not turn notifications on here.");
      }
    });

  const turnOff = () =>
    start(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await actions.unsubscribe({ endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => undefined);
      }
      setThisEndpoint(null);
      setNote("Turned off on this device.");
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="opacity-80">
        Reminders on your phone for upkeep, registrations and inspections, return deadlines, and new things to review. No
        bills. They come between 8 AM and 9 PM, once per reminder, and say only what the item is: never amounts, account
        details or codes. Your private accounts and your email finds notify only you.
      </p>
      {support === "ios-install" ? (
        <p className="rounded-lg border p-3">On iPhone, first add this app to the Home Screen (Share, then Add to Home Screen), open it from there, and come back here.</p>
      ) : support === "none" ? (
        <p className="rounded-lg border p-3">This browser can&apos;t receive notifications. Use the installed app in Chrome on Android or Safari on iPhone.</p>
      ) : support === "blocked" ? (
        <p className="rounded-lg border p-3">Notifications are blocked for this app. Allow them in the phone&apos;s settings for this app or site, then come back.</p>
      ) : null}
      {support === "ok" ? (
        <div className="flex flex-wrap items-center gap-2">
          {registered ? (
            <>
              <span>On for this device.</span>
              <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={turnOff}>
                Turn off here
              </button>
            </>
          ) : (
            <button type="button" disabled={pending} className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50" onClick={turnOn}>
              Turn on for this device
            </button>
          )}
          {devices.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              className="underline disabled:opacity-50"
              onClick={() => start(async () => setNote((await actions.test({})).message))}
            >
              Send a test
            </button>
          ) : null}
        </div>
      ) : null}
      {devices.length > 0 ? (
        <ul className="space-y-1">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-lg border p-2">
              <span className="flex-1">
                {d.label}
                {d.endpoint === thisEndpoint ? " (this one)" : ""}
                <span className="opacity-60"> · added {d.createdAt.slice(0, 10)}</span>
              </span>
              <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => start(() => actions.unsubscribe({ id: d.id }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="opacity-60">No devices yet.</p>
      )}
      <fieldset className="space-y-2">
        <legend className="opacity-70">Tell me about</legend>
        {NOTIFICATION_TYPES.map((t: NotificationType) => (
          <label key={t} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              defaultChecked={prefs[t]}
              disabled={pending}
              onChange={(e) => {
                const next = { ...prefs, [t]: e.currentTarget.checked };
                start(() => actions.savePrefs(next));
              }}
            />
            <span>
              {NOTIFICATION_LABELS[t].label}
              <span className="block opacity-60">{NOTIFICATION_LABELS[t].help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {note ? <p role="status" className="opacity-80">{note}</p> : null}
    </div>
  );
}
