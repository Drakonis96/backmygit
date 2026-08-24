import { describe, expect, it } from 'vitest';
import { nextScheduledAfterAnchor, nextScheduledAt } from './schedule.js';
import type { Schedule } from './types.js';

const base: Schedule = { enabled: true, type: 'daily', time: '03:00', timezone: 'UTC', interval: 1, daysOfWeek: [1], dayOfMonth: 1 };

describe('persisted schedules', () => {
  it('returns no execution when disabled', () => {
    expect(nextScheduledAt({ ...base, enabled: false }, new Date('2026-08-24T00:00:00Z'))).toBeNull();
  });

  it('schedules daily work at the requested local time', () => {
    expect(nextScheduledAt(base, new Date('2026-08-24T01:00:00Z'))?.toISOString()).toBe('2026-08-24T03:00:00.000Z');
    expect(nextScheduledAt(base, new Date('2026-08-24T04:00:00Z'))?.toISOString()).toBe('2026-08-25T03:00:00.000Z');
  });

  it('honors selected weekdays', () => {
    const schedule: Schedule = { ...base, type: 'weekly', daysOfWeek: [3, 5] };
    expect(nextScheduledAt(schedule, new Date('2026-08-24T12:00:00Z'))?.toISOString()).toBe('2026-08-26T03:00:00.000Z');
  });

  it('uses the final day in short months when needed', () => {
    const schedule: Schedule = { ...base, type: 'monthly', dayOfMonth: 31 };
    expect(nextScheduledAt(schedule, new Date('2026-02-01T00:00:00Z'))?.toISOString()).toBe('2026-02-28T03:00:00.000Z');
  });

  it('supports interval schedules', () => {
    const schedule: Schedule = { ...base, type: 'interval_weeks', interval: 2 };
    expect(nextScheduledAt(schedule, new Date('2026-08-24T04:00:00Z'))?.toISOString()).toBe('2026-09-07T03:00:00.000Z');
  });

  it('keeps interval schedules anchored after delayed execution', () => {
    const schedule: Schedule = { ...base, type: 'interval_days', interval: 3 };
    expect(
      nextScheduledAfterAnchor(
        schedule,
        new Date('2026-08-24T03:00:00Z'),
        new Date('2026-08-25T12:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-08-27T03:00:00.000Z');
    expect(
      nextScheduledAfterAnchor(
        schedule,
        new Date('2026-08-24T03:00:00Z'),
        new Date('2026-09-02T12:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-05T03:00:00.000Z');
  });
});
