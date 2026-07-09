// Simple client-side storage for the "Próximas Cobranças" reminder feature.
// Kept fully in localStorage to avoid changing any DB rules.

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

// Marks -----------------------------------------------------------------

const MARKS_KEY = "upcoming_reminder_marks_v1";

export type ReminderMark = {
  installment_id: string;
  loan_id: string;
  client_id: string | null;
  worker_id: string | null;
  at: string; // ISO
};

function readAll(): Record<string, ReminderMark> {
  try {
    const raw = localStorage.getItem(MARKS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function writeAll(map: Record<string, ReminderMark>) {
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(map)); } catch { /* noop */ }
}

export function getReminderMark(installmentId: string): ReminderMark | null {
  const m = readAll();
  return m[installmentId] || null;
}

export function saveReminderMark(m: ReminderMark) {
  const map = readAll();
  map[m.installment_id] = m; // dedupe by installment_id, always overwrite with latest
  writeAll(map);
}
