// Client-side preference storage for reminder lead time (2..5 days).
// Reminder "sent" marks are persisted in the DB (installment_reminders).

export type ReminderDays = 2 | 3 | 4 | 5;
const DEFAULT_DAYS: ReminderDays = 3;

function prefKey(workerId: string | null | undefined) {
  return `upcoming_reminder_days:${workerId || "global"}`;
}

export function getReminderDays(workerId?: string | null): ReminderDays {
  try {
    const raw = localStorage.getItem(prefKey(workerId));
    const n = raw ? Number(raw) : NaN;
    if ([2, 3, 4, 5].includes(n)) return n as ReminderDays;
  } catch { /* noop */ }
  return DEFAULT_DAYS;
}

export function setReminderDays(days: ReminderDays, workerId?: string | null) {
  try { localStorage.setItem(prefKey(workerId), String(days)); } catch { /* noop */ }
}

export type ReminderMark = {
  installment_id: string;
  loan_id: string;
  client_id: string | null;
  worker_id: string | null;
  at: string; // ISO reminded_at
};
