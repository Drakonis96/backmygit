import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import i18n from "./i18n";
import { api, mutate } from "./api";
import type { Settings } from "./types";

type PreferenceContextValue = {
  settings?: Settings;
  loading: boolean;
  error?: Error;
  resolvedTheme: "light" | "dark";
  saveSettings: (settings: Settings) => Promise<Settings>;
  previewLanguage: (language: Settings["language"]) => void;
  previewAppearance: (appearance: Settings["appearance"]) => void;
};

const PreferenceContext = createContext<PreferenceContextValue | null>(null);

export function applyLanguage(language: Settings["language"]) {
  localStorage.setItem("backmygit-language", language);
  void i18n.changeLanguage(language);
}

export function applyAppearance(appearance: Settings["appearance"]) {
  const dark =
    appearance === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
      : appearance === "dark";
  localStorage.setItem("backmygit-appearance", appearance);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const previewAppearance = useCallback((appearance: Settings["appearance"]) => {
    applyAppearance(appearance);
    setResolvedTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
  }, []);

  useEffect(() => {
    let active = true;
    void api<Settings>("/settings")
      .then((stored) => {
        if (!active) return;
        setSettings(stored);
        applyLanguage(stored.language);
        previewAppearance(stored.appearance);
      })
      .catch((reason) => {
        if (active) setError(reason as Error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [previewAppearance]);

  useEffect(() => {
    if (settings?.appearance !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => previewAppearance("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [settings?.appearance, previewAppearance]);

  const saveSettings = useCallback(async (next: Settings) => {
    const stored = await mutate<Settings>("/settings", "PUT", next);
    setSettings(stored);
    applyLanguage(stored.language);
    previewAppearance(stored.appearance);
    setError(undefined);
    return stored;
  }, [previewAppearance]);

  const value = useMemo<PreferenceContextValue>(
    () => ({
      settings,
      loading,
      error,
      resolvedTheme,
      saveSettings,
      previewLanguage: applyLanguage,
      previewAppearance,
    }),
    [settings, loading, error, resolvedTheme, saveSettings, previewAppearance],
  );

  return (
    <PreferenceContext.Provider value={value}>
      {children}
    </PreferenceContext.Provider>
  );
}

export function usePreferences() {
  const value = useContext(PreferenceContext);
  if (!value)
    throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
