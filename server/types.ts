export type ScheduleType = 'daily' | 'weekly' | 'monthly' | 'interval_days' | 'interval_weeks' | 'interval_months';

export interface Schedule {
  enabled: boolean;
  type: ScheduleType;
  time: string;
  timezone: string;
  interval: number;
  daysOfWeek: number[];
  dayOfMonth: number;
}

export interface Retention {
  mode: 'forever' | 'age' | 'latest' | 'combined';
  ageValue: number;
  ageUnit: 'days' | 'weeks' | 'months';
  keepLatest: number;
  minimumToKeep: number;
}

export interface AppSettings {
  timezone: string;
  language: 'en' | 'es';
  appearance: 'light' | 'dark' | 'system';
  defaultBranchMode: 'default' | 'all';
  defaultSchedule: Schedule;
  defaultRetention: Retention;
}

export const DEFAULT_SETTINGS: AppSettings = {
  timezone: 'UTC', language: 'en', appearance: 'system', defaultBranchMode: 'default',
  defaultSchedule: { enabled: true, type: 'daily', time: '03:00', timezone: 'UTC', interval: 1, daysOfWeek: [1], dayOfMonth: 1 },
  defaultRetention: { mode: 'forever', ageValue: 3, ageUnit: 'months', keepLatest: 10, minimumToKeep: 1 }
};

export interface BackupMetadata {
  schemaVersion: 1;
  applicationVersion: string;
  repository: { owner: string; name: string; url: string };
  branch: string;
  commitSha: string;
  startedAt: string;
  completedAt: string;
  status: 'success';
  origin: 'manual' | 'automatic';
  sizeBytes: number;
}
