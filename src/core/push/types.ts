/** Shared by the server and the Settings panel (no secrets here). */
export type Member = "user1" | "user2";

export const NOTIFICATION_TYPES = ["upkeep", "registrations", "returns", "suggestions"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationPrefs = Record<NotificationType, boolean>;

export const NOTIFICATION_LABELS: Record<NotificationType, { label: string; help: string }> = {
  upkeep: { label: "House and car upkeep", help: "Three days before an item is due, on the day, and once if it goes overdue." },
  registrations: { label: "Registrations and inspections", help: "Two weeks before, on the day, and once if overdue." },
  returns: { label: "Return deadlines", help: "Three days before the last day to return something, and on the day." },
  suggestions: { label: "New things to review", help: "Transactions to look at (yours and joint only) and returns found in your email." },
};

export const DEFAULT_PREFS: NotificationPrefs = { upkeep: true, registrations: true, returns: true, suggestions: true };

/** Push services the server may send to (also in core/net/hosts.ts). */
export const PUSH_HOSTS = ["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"] as const;

export type PushMessage = { title: string; body: string; url: string; tag: string };
