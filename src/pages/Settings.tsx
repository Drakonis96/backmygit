import {
  BookOpen,
  ExternalLink,
  Github,
  Globe2,
  Monitor,
  Save,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/Toast";
import TimezonePicker from "../components/TimezonePicker";
import {
  Card,
  Loading,
  PageHeader,
  RetentionForm,
  ScheduleForm,
  Segmented,
  Spinner,
} from "../components/UI";
import { usePreferences } from "../preferences";
import type { Settings } from "../types";

export default function SettingsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    settings,
    loading,
    error,
    saveSettings,
    previewLanguage,
    previewAppearance,
  } = usePreferences();
  const [value, setValue] = useState<Settings>();
  const [saving, setSaving] = useState(false);
  const persisted = useRef<Settings | undefined>(undefined);
  useEffect(() => {
    if (!settings) return;
    persisted.current = settings;
    setValue(settings);
  }, [settings]);
  useEffect(() => {
    return () => {
      if (!persisted.current) return;
      previewLanguage(persisted.current.language);
      previewAppearance(persisted.current.appearance);
    };
  }, [previewAppearance, previewLanguage]);
  if (loading) return <Loading />;
  if (error || !value)
    return (
      <Card>
        <div className="settings-load-error">
          <b>{t("settingsLoadError")}</b>
          <button className="button secondary" onClick={() => window.location.reload()}>
            {t("retry")}
          </button>
        </div>
      </Card>
    );
  const save = async () => {
    setSaving(true);
    try {
      const stored = await saveSettings(value);
      persisted.current = stored;
      toast(t("saved"));
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <PageHeader
        title={t("globalSettings")}
        description={t("defaultsHelp")}
        actions={
          <button className="button primary" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : <Save />}
            {t("save")}
          </button>
        }
      />
      <div className="settings-stack">
        <div className="two-column settings-preferences">
          <Card title={t("language")}>
            <div className="setting-intro">
              <Globe2 />
              <p>{t("languageNote")}</p>
            </div>
            <Segmented
              value={value.language}
              onChange={(language) => {
                const next = language as Settings["language"];
                setValue({ ...value, language: next });
                previewLanguage(next);
              }}
              options={[
                { value: "en", label: t("english") },
                { value: "es", label: t("spanish") },
              ]}
            />
          </Card>
          <Card title={t("appearance")}>
            <div className="setting-intro">
              <Monitor />
              <p>{t("appearanceNote")}</p>
            </div>
            <Segmented
              value={value.appearance}
              onChange={(appearance) => {
                const next = appearance as Settings["appearance"];
                setValue({ ...value, appearance: next });
                previewAppearance(next);
              }}
              options={[
                { value: "system", label: t("system") },
                { value: "light", label: t("light") },
                { value: "dark", label: t("dark") },
              ]}
            />
          </Card>
        </div>
        <Card title={t("defaultBranchBehaviour")}>
          <p className="setting-help">{t("defaultBranchHelp")}</p>
          <Segmented
            value={value.defaultBranchMode}
            onChange={(defaultBranchMode) =>
              setValue({
                ...value,
                defaultBranchMode:
                  defaultBranchMode as Settings["defaultBranchMode"],
              })
            }
            options={[
              { value: "default", label: t("defaultOnly") },
              { value: "all", label: t("allBranches") },
            ]}
          />
        </Card>
        <Card title={t("timezone")}>
          <p className="setting-help">{t("timezoneHelp")}</p>
          <TimezonePicker
            value={value.timezone}
            onChange={(timezone) =>
              setValue({
                ...value,
                timezone,
                defaultSchedule: { ...value.defaultSchedule, timezone },
              })
            }
          />
        </Card>
        <div className="two-column config-columns">
          <Card title={t("schedule")}>
            <ScheduleForm
              value={value.defaultSchedule}
              onChange={(defaultSchedule) =>
                setValue({
                  ...value,
                  timezone: defaultSchedule.timezone,
                  defaultSchedule,
                })
              }
            />
          </Card>
          <Card title={t("retention")}>
            <RetentionForm
              value={value.defaultRetention}
              onChange={(defaultRetention) =>
                setValue({ ...value, defaultRetention })
              }
            />
          </Card>
        </div>
        <Card title={t("projectLinks")} className="project-links-card">
          <a href="https://github.com/Drakonis96/backmygit" target="_blank" rel="noreferrer">
            <Github />
            <span><b>{t("githubRepository")}</b><small>github.com/Drakonis96/backmygit</small></span>
            <ExternalLink />
          </a>
          <a href="https://github.com/Drakonis96/backmygit#readme" target="_blank" rel="noreferrer">
            <BookOpen />
            <span><b>{t("documentation")}</b><small>{t("readmeDescription")}</small></span>
            <ExternalLink />
          </a>
        </Card>
      </div>
    </>
  );
}
