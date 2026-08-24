import { Check, Globe2, LoaderCircle, MapPin, Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { useDebounce } from "../hooks";

type LocationResult = {
  id: number;
  name: string;
  country: string;
  countryCode: string;
  admin1: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

const intlWithTimezones = Intl as typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

export default function TimezonePicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (timezone: string) => void;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LocationResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const debounced = useDebounce(query.trim(), 400);
  const timezones = useMemo(() => {
    const available = intlWithTimezones.supportedValuesOf?.("timeZone") || [];
    return Array.from(new Set(["UTC", value, ...available])).sort();
  }, [value]);

  useEffect(() => {
    if (debounced.length < 2) {
      setItems([]);
      setError("");
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setError("");
    void api<{ items: LocationResult[] }>(
      `/locations/timezones?q=${encodeURIComponent(debounced)}&language=${i18n.language.startsWith("es") ? "es" : "en"}`,
      { signal: controller.signal },
    )
      .then((response) => setItems(response.items))
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setItems([]);
        setError(
          reason instanceof ApiError && reason.code === "LOCATION_SERVICE_UNAVAILABLE"
            ? t("locationUnavailable")
            : t("unexpectedError"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [debounced, i18n.language, attempt, t]);

  const choose = (item: LocationResult) => {
    onChange(item.timezone);
    setQuery("");
    setItems([]);
  };

  return (
    <div className={`timezone-picker ${compact ? "compact" : ""}`}>
      <label>
        <span>{t("searchLocation")}</span>
        <div className="timezone-search">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("locationSearchHint")}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={resultsId}
            aria-autocomplete="list"
          />
          {searching && <LoaderCircle className="spin" />}
        </div>
      </label>
      {error && (
        <div className="timezone-error">
          <span>{error}</span>
          <button type="button" onClick={() => setAttempt((current) => current + 1)}>
            {t("retry")}
          </button>
        </div>
      )}
      {!searching && !error && debounced.length >= 2 && !items.length && (
        <div className="timezone-empty">{t("noLocations")}</div>
      )}
      {!!items.length && (
        <div className="timezone-results" id={resultsId} role="listbox">
          {items.map((item) => (
            <button
              type="button"
              key={`${item.id}-${item.timezone}`}
              role="option"
              aria-selected={item.timezone === value}
              onClick={() => choose(item)}
            >
              <MapPin />
              <span>
                <b>{item.name}</b>
                <small>{[item.admin1, item.country].filter(Boolean).join(", ")}</small>
              </span>
              <code>{item.timezone}</code>
              {item.timezone === value && <Check />}
            </button>
          ))}
        </div>
      )}
      <div className="timezone-current">
        <Globe2 />
        <span>
          <small>{t("selectedTimezone")}</small>
          <b>{value}</b>
        </span>
      </div>
      <label className="timezone-direct">
        <span>{t("chooseTimezoneDirectly")}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone}>
              {timezone}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
