import { DateTime } from 'luxon';
import type { Schedule } from './types.js';

const parseTime = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return { hour: Number.isFinite(hour) ? hour : 3, minute: Number.isFinite(minute) ? minute : 0, second: 0, millisecond: 0 };
};

export function nextScheduledAt(schedule: Schedule, after = new Date()): Date | null {
  if (!schedule.enabled) return null;
  const zone = DateTime.local().setZone(schedule.timezone).isValid ? schedule.timezone : 'UTC';
  const now = DateTime.fromJSDate(after, { zone });
  const clock = parseTime(schedule.time);
  const interval = Math.max(1, Math.floor(schedule.interval || 1));

  if (schedule.type.startsWith('interval_')) {
    let candidate = now.set(clock);
    if (candidate <= now) {
      if (schedule.type === 'interval_days') candidate = candidate.plus({ days: interval });
      if (schedule.type === 'interval_weeks') candidate = candidate.plus({ weeks: interval });
      if (schedule.type === 'interval_months') candidate = candidate.plus({ months: interval });
    }
    return candidate.toUTC().toJSDate();
  }

  for (let offset = 0; offset < 740; offset++) {
    const day = now.startOf('day').plus({ days: offset }).set(clock);
    if (day <= now) continue;
    if (schedule.type === 'daily') return day.toUTC().toJSDate();
    if (schedule.type === 'weekly' && (schedule.daysOfWeek?.length ? schedule.daysOfWeek : [1]).includes(day.weekday)) return day.toUTC().toJSDate();
    if (schedule.type === 'monthly' && day.day === Math.min(schedule.dayOfMonth || 1, day.daysInMonth ?? 28)) return day.toUTC().toJSDate();
  }
  return null;
}

export function nextScheduledAfterAnchor(
  schedule: Schedule,
  previous: Date,
  now = new Date(),
): Date | null {
  let anchor = new Date(previous.getTime() + 1000);
  let next = nextScheduledAt(schedule, anchor);
  while (next && next <= now) {
    anchor = new Date(next.getTime() + 1000);
    next = nextScheduledAt(schedule, anchor);
  }
  return next;
}
