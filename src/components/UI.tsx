import { AlertTriangle, ChevronDown, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Retention, Schedule, Status } from "../types";
import TimezonePicker from "./TimezonePicker";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function Card({
  children,
  className = "",
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="card-heading">
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" />;
}
export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="loading">
      <Spinner />
      <span>{t("loading")}</span>
    </div>
  );
}
export function StatusBadge({
  status,
}: {
  status: Status | string | undefined;
}) {
  const { t } = useTranslation();
  const key = status || "unknown";
  return (
    <span className={`badge status-${key}`}>
      <i />
      {t(key as any)}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "normal",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "normal" | "wide";
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      (first || dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [open]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${size}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={keyboard}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("close")}
            title={t("close")}
          >
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  warning,
  busy = false,
  requireCheck = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  warning: string;
  busy?: boolean;
  requireCheck?: boolean;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(!requireCheck);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="button ghost" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="button danger"
            disabled={busy || !checked}
            onClick={onConfirm}
          >
            {busy ? <Spinner /> : t("delete")}
          </button>
        </>
      }
    >
      <div className="warning-box">
        <AlertTriangle />
        <p>{warning}</p>
      </div>
      {requireCheck && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>{t("confirmDelete")}</span>
        </label>
      )}
    </Modal>
  );
}

const frequencyKeys: Record<Schedule["type"], string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  interval_days: "everyXDays",
  interval_weeks: "everyXWeeks",
  interval_months: "everyXMonths",
};
export function ScheduleForm({
  value,
  onChange,
}: {
  value: Schedule;
  onChange: (v: Schedule) => void;
}) {
  const { t } = useTranslation();
  const days = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  return (
    <div className="form-grid">
      <label className="toggle-field full">
        <span>
          <b>{t("automation")}</b>
          <small>{value.enabled ? t("active") : t("scheduleDisabled")}</small>
        </span>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <i />
      </label>
      <label>
        <span>{t("frequency")}</span>
        <select
          value={value.type}
          onChange={(e) =>
            onChange({ ...value, type: e.target.value as Schedule["type"] })
          }
        >
          {Object.entries(frequencyKeys).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label as any)}
            </option>
          ))}
        </select>
        <ChevronDown />
      </label>
      <label>
        <span>{t("executionTime")}</span>
        <input
          type="time"
          value={value.time}
          onInput={(e) =>
            onChange({ ...value, time: e.currentTarget.value })
          }
        />
      </label>
      <div className="full">
        <TimezonePicker
          compact
          value={value.timezone}
          onChange={(timezone) => onChange({ ...value, timezone })}
        />
      </div>
      {value.type.startsWith("interval_") && (
        <label>
          <span>{t("interval")}</span>
          <input
            type="number"
            min="1"
            max="365"
            value={value.interval}
            onChange={(e) =>
              onChange({ ...value, interval: Number(e.target.value) })
            }
          />
        </label>
      )}
      {value.type === "monthly" && (
        <label>
          <span>{t("dayOfMonth")}</span>
          <input
            type="number"
            min="1"
            max="31"
            value={value.dayOfMonth}
            onChange={(e) =>
              onChange({ ...value, dayOfMonth: Number(e.target.value) })
            }
          />
        </label>
      )}
      {value.type === "weekly" && (
        <fieldset className="full">
          <legend>{t("daysOfWeek")}</legend>
          <div className="day-picker">
            {days.map((day, i) => (
              <button
                type="button"
                className={value.daysOfWeek.includes(i + 1) ? "active" : ""}
                key={day}
                aria-pressed={value.daysOfWeek.includes(i + 1)}
                onClick={() => {
                  const selected = value.daysOfWeek.includes(i + 1);
                  if (selected && value.daysOfWeek.length === 1) return;
                  onChange({
                    ...value,
                    daysOfWeek: selected
                      ? value.daysOfWeek.filter((x) => x !== i + 1)
                      : [...value.daysOfWeek, i + 1],
                  });
                }}
              >
                {t(day as any)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function RetentionForm({
  value,
  onChange,
}: {
  value: Retention;
  onChange: (v: Retention) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="form-grid">
      <label className="full">
        <span>{t("retention")}</span>
        <select
          value={value.mode}
          onChange={(e) =>
            onChange({ ...value, mode: e.target.value as Retention["mode"] })
          }
        >
          <option value="forever">{t("keepForever")}</option>
          <option value="age">{t("olderThan")}</option>
          <option value="latest">{t("keepLatest")}</option>
          <option value="combined">{t("combined")}</option>
        </select>
        <ChevronDown />
      </label>
      {(value.mode === "age" || value.mode === "combined") && (
        <>
          <label>
            <span>{t("ageValue")}</span>
            <input
              type="number"
              min="1"
              value={value.ageValue}
              onChange={(e) =>
                onChange({ ...value, ageValue: Number(e.target.value) })
              }
            />
          </label>
          <label>
            <span>{t("ageUnit")}</span>
            <select
              value={value.ageUnit}
              onChange={(e) =>
                onChange({
                  ...value,
                  ageUnit: e.target.value as Retention["ageUnit"],
                })
              }
            >
              <option value="days">{t("days")}</option>
              <option value="weeks">{t("weeks")}</option>
              <option value="months">{t("months")}</option>
            </select>
            <ChevronDown />
          </label>
        </>
      )}
      {(value.mode === "latest" || value.mode === "combined") && (
        <label>
          <span>{t("latestCount")}</span>
          <input
            type="number"
            min="1"
            value={value.keepLatest}
            onChange={(e) =>
              onChange({ ...value, keepLatest: Number(e.target.value) })
            }
          />
        </label>
      )}
      {value.mode !== "forever" && (
        <label>
          <span>{t("minimumKeep")}</span>
          <input
            type="number"
            min="1"
            value={value.minimumToKeep}
            onChange={(e) =>
              onChange({ ...value, minimumToKeep: Number(e.target.value) })
            }
          />
        </label>
      )}
    </div>
  );
}

export function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
