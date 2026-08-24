import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  File,
  Folder,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, mutate, shortSha } from "../api";
import { useToast } from "../components/Toast";
import {
  Card,
  Empty,
  Loading,
  Modal,
  PageHeader,
} from "../components/UI";
import { useApi } from "../hooks";
import type { Backup } from "../types";

type Entry = {
  name: string;
  type: "directory" | "file" | "symlink";
  size: number;
  modifiedAt: string;
};
export default function Backups() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { data, loading, refresh } = useApi<{ items: Backup[] }>(
    "/backups",
    10000,
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [browse, setBrowse] = useState<Backup>();
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const items = useMemo(
    () =>
      data?.items.filter((b) =>
        `${b.owner}/${b.repository} ${b.branch} ${b.commit_sha}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) || [],
    [data, query],
  );
  const date = (v: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(v));
  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, Backup[]>>();
    for (const backup of items) {
      const repo = `${backup.owner}/${backup.repository}`;
      if (!map.has(repo)) map.set(repo, new Map());
      const branches = map.get(repo)!;
      if (!branches.has(backup.branch)) branches.set(backup.branch, []);
      branches.get(backup.branch)!.push(backup);
    }
    return map;
  }, [items]);
  const openBrowse = async (backup: Backup, target = "") => {
    setBrowse(backup);
    setCurrentPath(target);
    setBrowseLoading(true);
    try {
      const response = await fetch(
        `/api/backups/${backup.id}/contents?path=${encodeURIComponent(target)}`,
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      setEntries(result.items);
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setBrowseLoading(false);
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      if (selected.length === 1)
        await mutate(`/backups/${selected[0]}?remote=${deleteRemote}`, "DELETE");
      else await mutate("/backups/delete", "POST", { ids: selected, deleteRemote });
      toast(t("deletedSuccessfully"));
      setSelected([]);
      setDeleteRemote(false);
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setDeleting(false);
    }
  };
  const run = async (branchId: number) => {
    try {
      const result = await mutate<{ items: Array<{ queued: boolean }> }>(
        "/backups/run",
        "POST",
        { branchIds: [branchId] },
      );
      toast(result.items[0]?.queued ? t("requestQueued") : t("alreadyRunning"));
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const copy = async (path: string) => {
    await navigator.clipboard.writeText(path);
    toast(t("copied"));
  };
  const parent = () =>
    openBrowse(browse!, currentPath.split("/").slice(0, -1).join("/"));
  return (
    <>
      <PageHeader
        title={t("backupManager")}
        description={t("browseBackups")}
        actions={
          selected.length ? (
            <button className="button danger" onClick={() => setDeleting(true)}>
              <Trash2 />
              {t("deleteSelected")} · {selected.length}
            </button>
          ) : items[0] ? (
            <button className="button primary" onClick={() => run(items[0].branch_id)}>
              <Database />
              {t("backupNow")}
            </button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <label className="search-field">
          <Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
          />
        </label>
        <label className="check-row compact">
          <input
            type="checkbox"
            checked={!!items.length && selected.length === items.length}
            onChange={(e) =>
              setSelected(e.target.checked ? items.map((x) => x.id) : [])
            }
          />
          <span>{t("selectAll")}</span>
        </label>
      </div>
      {loading ? (
        <Loading />
      ) : !items.length ? (
        <Card>
          <Empty icon={<Archive />} title={t("noBackups")} />
        </Card>
      ) : (
        <div className="backup-groups">
          {[...grouped].map(([repo, branches]) => (
            <Card key={repo} className="backup-group">
              <div className="backup-repo-head">
                <div className="repo-icon">
                  <Archive />
                </div>
                <div>
                  <span>{repo.split("/")[0]}</span>
                  <h2>{repo.split("/")[1]}</h2>
                </div>
                <b>
                  {[...branches.values()].flat().length}{" "}
                  {t("backups").toLowerCase()}
                </b>
              </div>
              {[...branches].map(([branch, backups]) => (
                <div className="branch-group" key={branch}>
                  <div className="branch-group-head">
                    <span>{t("branch")}</span>
                    <b>{branch}</b>
                    <i>{backups.length}</i>
                  </div>
                  <div className="responsive-table">
                    <table>
                      <thead>
                        <tr>
                          <th />
                          <th>{t("date")}</th>
                          <th>{t("commit")}</th>
                          <th>{t("size")}</th>
                          <th>{t("duration")}</th>
                          <th>{t("origin")}</th>
                          <th>{t("actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backups.map((backup) => (
                          <tr key={backup.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`${t("select")} ${backup.owner}/${backup.repository} ${backup.branch} ${date(backup.completed_at)}`}
                                checked={selected.includes(backup.id)}
                                onChange={(e) =>
                                  setSelected((x) =>
                                    e.target.checked
                                      ? [...x, backup.id]
                                      : x.filter((y) => y !== backup.id),
                                  )
                                }
                              />
                            </td>
                            <td data-label={t("date")}>
                              <b>{date(backup.completed_at)}</b>
                            </td>
                            <td data-label={t("commit")}>
                              <code>{shortSha(backup.commit_sha)}</code>
                            </td>
                            <td data-label={t("size")}>
                              {formatBytes(backup.size_bytes)}
                            </td>
                            <td data-label={t("duration")}>
                              {(backup.duration_ms / 1000).toFixed(1)}s
                            </td>
                            <td data-label={t("origin")}>
                              <span className="badge neutral">
                                {t(backup.origin)}
                              </span>
                            </td>
                            <td>
                              <div className="table-actions">
                                <button
                                  className="icon-button"
                                  title={t("backupNow")}
                                  onClick={() => run(backup.branch_id)}
                                >
                                  <Database />
                                </button>
                                <button
                                  className="icon-button"
                                  title={t("browse")}
                                  onClick={() => openBrowse(backup)}
                                >
                                  <Folder />
                                </button>
                                <a
                                  className="icon-button"
                                  title={t("download")}
                                  href={`/api/backups/${backup.id}/download`}
                                >
                                  <Download />
                                </a>
                                {backup.path && <button
                                  className="icon-button"
                                  title={t("copyPath")}
                                  onClick={() => copy(backup.path!)}
                                >
                                  <Copy />
                                </button>}
                                <button
                                  className="icon-button danger-text"
                                  title={t("delete")}
                                  onClick={() => {
                                    setSelected([backup.id]);
                                    setDeleting(true);
                                  }}
                                >
                                  <Trash2 />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={!!browse}
        onClose={() => setBrowse(undefined)}
        title={`${t("contents")} · ${browse?.branch || ""}`}
        size="wide"
      >
        <div className="path-bar">
          <code>
            {browse?.path}
            {currentPath ? `/${currentPath}` : ""}
          </code>
          <button
            className="icon-button"
            onClick={() => browse && copy(`${browse.path}/${currentPath}`)}
            aria-label={t("copyPath")}
            title={t("copyPath")}
          >
            <Copy />
          </button>
        </div>
        {currentPath && (
          <button className="button ghost small" onClick={parent}>
            <ChevronLeft />
            {t("parentFolder")}
          </button>
        )}
        {browseLoading ? (
          <Loading />
        ) : !entries.length ? (
          <Empty icon={<Folder />} title={t("emptyFolder")} />
        ) : (
          <div className="file-list">
            {entries.map((entry) => (
              <button
                key={entry.name}
                onClick={() => {
                  const target = [currentPath, entry.name].filter(Boolean).join("/");
                  if (entry.type === "directory") void openBrowse(browse!, target);
                  else if (entry.type === "file") window.location.href = `/api/backups/${browse!.id}/file?path=${encodeURIComponent(target)}`;
                }}
              >
                {entry.type === "directory" ? <Folder /> : <File />}
                <span>
                  <b>{entry.name}</b>
                  <small>
                    {entry.type === "file"
                      ? formatBytes(entry.size)
                      : t("folder")}
                  </small>
                </span>
                {entry.type === "directory" && <ChevronRight />}
              </button>
            ))}
          </div>
        )}
      </Modal>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t("deleteBackupTitle")}
        footer={
          <>
            <button className="button ghost" onClick={() => setDeleting(false)}>
              {t("cancel")}
            </button>
            <button
              className="button danger"
              disabled={!selected.length}
              onClick={remove}
            >
              {t("delete")} · {selected.length}
            </button>
          </>
        }
      >
        <div className="warning-box">
          <Trash2 />
          <p>{t("deleteBackupWarning")}</p>
        </div>
        <label className="check-row"><input type="checkbox" checked={deleteRemote} onChange={event => setDeleteRemote(event.target.checked)} /><span>{t("deleteRemoteReplicas")}</span></label>
      </Modal>
    </>
  );
}
