import {
  ArrowLeft,
  Check,
  GitFork,
  LoaderCircle,
  Lock,
  Search,
  Star,
  Unlock,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, mutate } from "../api";
import {
  Card,
  PageHeader,
  RetentionForm,
  ScheduleForm,
  Segmented,
  Spinner,
} from "../components/UI";
import { useToast } from "../components/Toast";
import { useApi, useDebounce } from "../hooks";
import type { Retention, Schedule, Settings } from "../types";

type Result = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  stars: number;
  visibility: string;
  defaultBranch: string;
  updatedAt: string;
  url: string;
  archived: boolean;
};
export default function AddRepositories() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: settings } = useApi<Settings>("/settings");
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query.trim(), 350);
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [selected, setSelected] = useState<Result[]>([]);
  const [branchMode, setBranchMode] = useState<"default" | "all">("default");
  const [saving, setSaving] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | undefined>();
  const [retention, setRetention] = useState<Retention | undefined>();
  useEffect(() => {
    if (settings) {
      setSchedule(settings.defaultSchedule);
      setRetention(settings.defaultRetention);
      setBranchMode(settings.defaultBranchMode);
    }
  }, [settings]);
  useEffect(() => {
    if (debounced.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setSearching(true);
    setError("");
    api<{ items: Result[] }>(
      `/github/search?q=${encodeURIComponent(debounced)}`,
      { signal: controller.signal },
    )
      .then((x) => {
        if (active) setResults(x.items);
      })
      .catch((e) => {
        if (!active || e?.name === "AbortError") return;
        const error = e as ApiError;
        if (error.code === "SERVER_UNAVAILABLE")
          setError(t("serverUnavailable"));
        else if (error.code === "GITHUB_UNAVAILABLE")
          setError(t("githubUnavailable"));
        else if (error.status === 429) setError(t("githubRateLimit"));
        else setError(t("unexpectedError"));
      })
      .finally(() => {
        if (active) setSearching(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [debounced, t, searchAttempt]);
  const toggle = (repo: Result) =>
    setSelected((items) =>
      items.some((x) => x.id === repo.id)
        ? items.filter((x) => x.id !== repo.id)
        : [...items, repo],
    );
  const submit = async () => {
    if (!selected.length || !schedule || !retention) return;
    setSaving(true);
    try {
      await mutate("/repositories", "POST", {
        repositories: selected.map((r) => ({
          ...r,
          allBranches: branchMode === "all",
        })),
        schedule,
        retention,
      });
      toast(t("repositoryAdded"));
      navigate("/repositories");
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setSaving(false);
    }
  };
  const date = (v: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
      new Date(v),
    );
  return (
    <>
      <PageHeader
        title={t("addRepositories")}
        description={t("searchGithub")}
        actions={
          <Link className="button ghost" to="/repositories">
            <ArrowLeft />
            {t("repositories")}
          </Link>
        }
      />
      <Card className="discovery">
        <label className="discovery-search">
          <Search />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchHint")}
            aria-label={t("searchGithub")}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label={t("clearSearch")}
              title={t("clearSearch")}
            >
              <X />
            </button>
          )}
        </label>
        {searching && (
          <div className="search-message">
            <LoaderCircle className="spin" />
            {t("searching")}
          </div>
        )}
        {error && (
          <div className="search-error">
            <span>{error}</span>
            <button
              className="button secondary small"
              onClick={() => setSearchAttempt((value) => value + 1)}
            >
              {t("retry")}
            </button>
          </div>
        )}
        {!searching && debounced.length >= 2 && !error && !results.length && (
          <div className="search-message">{t("noResults")}</div>
        )}
        {!!results.length && (
          <div className="search-results">
            {results.map((repo) => {
              const active = selected.some((x) => x.id === repo.id);
              return (
                <button
                  className={`search-result ${active ? "selected" : ""}`}
                  key={repo.id}
                  onClick={() => toggle(repo)}
                >
                  <span className="result-check">{active && <Check />}</span>
                  <span className="result-main">
                    <b>
                      {repo.owner}/<strong>{repo.name}</strong>
                    </b>
                    <small>{repo.description || t("noDescription")}</small>
                    <span className="result-url">{repo.url}</span>
                    <span className="result-meta">
                      <i>
                        {repo.visibility === "private" ? <Lock /> : <Unlock />}
                        {t(repo.visibility as any)}
                      </i>
                      <i>
                        <Star />
                        {repo.stars.toLocaleString()}
                      </i>
                      <i>
                        <GitFork />
                        {repo.defaultBranch}
                      </i>
                      <i>{date(repo.updatedAt)}</i>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
      {!!selected.length && schedule && retention && (
        <div className="configuration">
          <div className="selection-bar">
            <div>
              <b>{selected.length}</b>
              <span>{t("selectedRepositories")}</span>
            </div>
            <div className="selection-chips">
              {selected.map((r) => (
                <button key={r.id} onClick={() => toggle(r)}>
                  {r.owner}/{r.name}
                  <X />
                </button>
              ))}
            </div>
          </div>
          <div className="two-column config-columns">
            <Card title={t("schedule")}>
              <ScheduleForm value={schedule} onChange={setSchedule} />
            </Card>
            <Card title={t("retention")}>
              <RetentionForm value={retention} onChange={setRetention} />
            </Card>
          </div>
          <Card title={t("branchSelection")}>
            <Segmented
              value={branchMode}
              onChange={(v) => setBranchMode(v as any)}
              options={[
                { value: "default", label: t("defaultOnly") },
                { value: "all", label: t("allBranches") },
              ]}
            />
          </Card>
          <div className="sticky-submit">
            <button
              className="button primary large"
              disabled={saving}
              onClick={submit}
            >
              {saving ? (
                <>
                  <Spinner />
                  {t("configuring")}
                </>
              ) : (
                <>
                  {t("addSelected")} · {selected.length}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
