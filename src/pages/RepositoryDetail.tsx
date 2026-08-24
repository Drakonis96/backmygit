import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Database,
  GitBranch,
  HardDrive,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatBytes, mutate } from "../api";
import { useToast } from "../components/Toast";
import {
  Card,
  Empty,
  Loading,
  Modal,
  PageHeader,
  RetentionForm,
  ScheduleForm,
  Spinner,
  StatusBadge,
} from "../components/UI";
import { useApi } from "../hooks";
import type { Retention, Run, Schedule, Status } from "../types";

type Branch = {
  id: number;
  name: string;
  enabled: number;
  configured: number;
  schedule: Schedule | null;
  retention: Retention | null;
  next_run_at?: string;
  lastBackup?: string;
  backupCount: number;
  sizeBytes: number;
  lastStatus?: Status;
};
type Detail = {
  id: number;
  owner: string;
  name: string;
  url: string;
  description: string;
  stars: number;
  visibility: string;
  default_branch: string;
  enabled: number;
  schedule: Schedule;
  retention: Retention;
  backupCount: number;
  sizeBytes: number;
  lastBackup?: string;
  nextBackup?: string;
  branches: Branch[];
  history: Run[];
};
type Available = {
  name: string;
  sha: string;
  protected: boolean;
  configured: boolean;
};
export default function RepositoryDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, refresh } = useApi<Detail>(
    `/repositories/${id}`,
    10000,
  );
  const [modal, setModal] = useState<
    "schedule" | "retention" | "branches" | "delete" | null
  >(null);
  const [schedule, setSchedule] = useState<Schedule>();
  const [retention, setRetention] = useState<Retention>();
  const [available, setAvailable] = useState<Available[]>([]);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [editingBranch, setEditingBranch] = useState<Branch>();
  const [inheritSchedule, setInheritSchedule] = useState(true);
  const [inheritRetention, setInheritRetention] = useState(true);
  useEffect(() => {
    if (data) {
      setSchedule(data.schedule);
      setRetention(data.retention);
    }
  }, [data]);
  const date = (v?: string) =>
    v
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(v))
      : "—";
  if (loading) return <Loading />;
  if (!data)
    return (
      <Card>
        <Empty title={t("unexpectedError")} />
      </Card>
    );
  const patch = async (body: unknown) => {
    setBusy(true);
    try {
      await mutate(`/repositories/${id}`, "PATCH", body);
      toast(t("saved"));
      setModal(null);
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setBusy(false);
    }
  };
  const backup = async (branchIds?: number[]) => {
    try {
      const result = await mutate<{ items: Array<{ queued: boolean }> }>(
        "/backups/run",
        "POST",
        branchIds ? { branchIds } : { repositoryId: data.id },
      );
      toast(
        result.items.some((x) => x.queued)
          ? t("requestQueued")
          : t("alreadyRunning"),
      );
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const openBranches = async () => {
    setModal("branches");
    setBranchLoading(true);
    try {
      const r = await (
        await fetch(`/api/repositories/${id}/available-branches`)
      ).json();
      setAvailable(r.items);
      setSelectedBranches([]);
    } catch {
      toast(t("unavailableBranches"), "error");
    } finally {
      setBranchLoading(false);
    }
  };
  const addBranches = async () => {
    setBusy(true);
    try {
      await mutate(`/repositories/${id}/branches`, "POST", {
        names: selectedBranches,
      });
      toast(t("saved"));
      setModal(null);
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setBusy(false);
    }
  };
  const toggleBranch = async (branch: Branch) => {
    try {
      await mutate(`/branches/${branch.id}`, "PATCH", {
        enabled: !branch.enabled,
      });
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const removeBranch = async (branch: Branch) => {
    try {
      await mutate(`/branches/${branch.id}`, "PATCH", {
        configured: false,
        enabled: false,
      });
      toast(t("saved"));
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const openBranchEdit = (branch: Branch) => {
    setEditingBranch({
      ...branch,
      schedule: branch.schedule || data.schedule,
      retention: branch.retention || data.retention,
    });
    setInheritSchedule(!branch.schedule);
    setInheritRetention(!branch.retention);
  };
  const saveBranch = async () => {
    if (!editingBranch) return;
    setBusy(true);
    try {
      await mutate(`/branches/${editingBranch.id}`, "PATCH", {
        schedule: inheritSchedule ? null : editingBranch.schedule,
        retention: inheritRetention ? null : editingBranch.retention,
      });
      toast(t("saved"));
      setEditingBranch(undefined);
      await refresh();
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setBusy(false);
    }
  };
  const removeRepo = async () => {
    setBusy(true);
    try {
      await mutate(`/repositories/${id}?deleteFiles=${deleteFiles}`, "DELETE");
      toast(t("deletedSuccessfully"));
      navigate("/repositories");
    } catch {
      toast(t("unexpectedError"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title={`${data.owner}/${data.name}`}
        description={data.description || t("noDescription")}
        actions={
          <>
            <Link className="button ghost" to="/repositories">
              <ArrowLeft />
              {t("repositories")}
            </Link>
            <button
              className="button primary"
              onClick={() => backup()}
              disabled={!data.enabled}
            >
              <Database />
              {t("backupNow")}
            </button>
          </>
        }
      />
      <div className="detail-stats">
        <Card>
          <span>{t("status")}</span>
          <button
            className="status-toggle"
            onClick={() => patch({ enabled: !data.enabled })}
          >
            <StatusBadge status={data.enabled ? "healthy" : "disabled"} />
            <i className={`toggle ${data.enabled ? "on" : ""}`}>
              <i />
            </i>
          </button>
        </Card>
        <Card>
          <span>{t("branches")}</span>
          <b>{data.branches.filter((x) => x.configured).length}</b>
        </Card>
        <Card>
          <span>{t("totalBackups")}</span>
          <b>{data.backupCount}</b>
        </Card>
        <Card>
          <span>{t("totalStorage")}</span>
          <b>{formatBytes(data.sizeBytes)}</b>
        </Card>
        <Card>
          <span>{t("lastBackup")}</span>
          <b>{date(data.lastBackup)}</b>
        </Card>
        <Card>
          <span>{t("nextScheduled")}</span>
          <b>{date(data.nextBackup)}</b>
        </Card>
      </div>
      <div className="two-column settings-summary">
        <Card
          title={t("schedule")}
          actions={
            <button
              className="icon-button"
              onClick={() => setModal("schedule")}
              aria-label={`${t("edit")} ${t("schedule")}`}
              title={`${t("edit")} ${t("schedule")}`}
            >
              <Settings2 />
            </button>
          }
        >
          <div className="summary-row">
            <CalendarClock />
            <div>
              <b>
                {t(
                  data.schedule.type === "interval_days"
                    ? "everyXDays"
                    : data.schedule.type === "interval_weeks"
                      ? "everyXWeeks"
                      : data.schedule.type === "interval_months"
                        ? "everyXMonths"
                        : data.schedule.type,
                )}
              </b>
              <span>
                {data.schedule.time} · {data.schedule.timezone}
              </span>
            </div>
          </div>
        </Card>
        <Card
          title={t("retention")}
          actions={
            <button
              className="icon-button"
              onClick={() => setModal("retention")}
              aria-label={`${t("edit")} ${t("retention")}`}
              title={`${t("edit")} ${t("retention")}`}
            >
              <Settings2 />
            </button>
          }
        >
          <div className="summary-row">
            <HardDrive />
            <div>
              <b>
                {t(
                  data.retention.mode === "forever"
                    ? "keepForever"
                    : data.retention.mode === "age"
                      ? "olderThan"
                      : data.retention.mode === "latest"
                        ? "keepLatest"
                        : "combined",
                )}
              </b>
              <span>
                {data.retention.mode === "forever"
                  ? "—"
                  : `${data.retention.minimumToKeep} ${t("minimumKeep").toLowerCase()}`}
              </span>
            </div>
          </div>
        </Card>
      </div>
      <Card
        title={t("configuredBranches")}
        actions={
          <button className="button secondary small" onClick={openBranches}>
            <Plus />
            {t("addBranches")}
          </button>
        }
      >
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>{t("branch")}</th>
                <th>{t("status")}</th>
                <th>{t("lastBackup")}</th>
                <th>{t("nextScheduled")}</th>
                <th>{t("backups")}</th>
                <th>{t("storage")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.branches
                .filter((x) => x.configured)
                .map((branch) => (
                  <tr key={branch.id}>
                    <td data-label={t("branch")}>
                      <div className="branch-name">
                        <GitBranch />
                        <b>{branch.name}</b>
                        {branch.name === data.default_branch && (
                          <span className="badge neutral">
                            {t("defaultBranch")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label={t("status")}>
                      <StatusBadge
                        status={
                          !branch.enabled
                            ? "disabled"
                            : branch.lastStatus === "failed"
                              ? "failed"
                              : branch.lastStatus === "running"
                                ? "running"
                                : "scheduled"
                        }
                      />
                    </td>
                    <td data-label={t("lastBackup")}>
                      {date(branch.lastBackup)}
                    </td>
                    <td data-label={t("nextScheduled")}>
                      {date(branch.next_run_at)}
                    </td>
                    <td data-label={t("backups")}>{branch.backupCount}</td>
                    <td data-label={t("storage")}>
                      {formatBytes(branch.sizeBytes)}
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="icon-button"
                          title={t("backupNow")}
                          onClick={() => backup([branch.id])}
                        >
                          <Database />
                        </button>
                        <button
                          className="icon-button"
                          title={t("edit")}
                          onClick={() => openBranchEdit(branch)}
                        >
                          <Settings2 />
                        </button>
                        <button
                          className={`toggle ${branch.enabled ? "on" : ""}`}
                          onClick={() => toggleBranch(branch)}
                          aria-label={t(branch.enabled ? "disable" : "enable")}
                          title={t(branch.enabled ? "disable" : "enable")}
                        >
                          <i />
                        </button>
                        <button
                          className="icon-button danger-text"
                          title={t("removeBranch")}
                          onClick={() => removeBranch(branch)}
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
      </Card>
      <Card title={t("recentHistory")}>
        <div className="activity-list">
          {!data.history.length ? (
            <Empty title={t("noRuns")} />
          ) : (
            data.history.map((run) => (
              <div className="activity" key={run.id}>
                <div className={`activity-icon status-${run.status}`}>
                  <RefreshCw />
                </div>
                <div className="activity-main">
                  <b>{run.branch}</b>
                  <span>
                    {t(run.origin)} · {date(run.created_at)}
                  </span>
                </div>
                <StatusBadge status={run.status} />
              </div>
            ))
          )}
        </div>
      </Card>
      <div className="danger-zone">
        <div>
          <b>{t("deleteRepository")}</b>
          <span>{t("deleteRepositoryWarning")}</span>
        </div>
        <button
          className="button danger-outline"
          onClick={() => setModal("delete")}
        >
          <Trash2 />
          {t("delete")}
        </button>
      </div>
      <Modal
        open={modal === "schedule"}
        onClose={() => setModal(null)}
        title={t("schedule")}
        footer={
          <>
            <button className="button ghost" onClick={() => setModal(null)}>
              {t("cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => schedule && patch({ schedule })}
            >
              {busy ? <Spinner /> : t("save")}
            </button>
          </>
        }
      >
        {schedule && <ScheduleForm value={schedule} onChange={setSchedule} />}
      </Modal>
      <Modal
        open={modal === "retention"}
        onClose={() => setModal(null)}
        title={t("retention")}
        footer={
          <>
            <button className="button ghost" onClick={() => setModal(null)}>
              {t("cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => retention && patch({ retention })}
            >
              {busy ? <Spinner /> : t("save")}
            </button>
          </>
        }
      >
        {retention && (
          <RetentionForm value={retention} onChange={setRetention} />
        )}
      </Modal>
      <Modal
        open={modal === "branches"}
        onClose={() => setModal(null)}
        title={t("chooseBranches")}
        footer={
          <>
            <button className="button ghost" onClick={() => setModal(null)}>
              {t("cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy || !selectedBranches.length}
              onClick={addBranches}
            >
              {busy ? <Spinner /> : t("addBranches")}
            </button>
          </>
        }
      >
        {branchLoading ? (
          <Loading />
        ) : (
          <div className="branch-picker">
            {available.map((branch) => (
              <label
                className={branch.configured ? "disabled" : ""}
                key={branch.name}
              >
                <input
                  type="checkbox"
                  disabled={branch.configured}
                  checked={
                    branch.configured || selectedBranches.includes(branch.name)
                  }
                  onChange={(e) =>
                    setSelectedBranches((x) =>
                      e.target.checked
                        ? [...x, branch.name]
                        : x.filter((y) => y !== branch.name),
                    )
                  }
                />
                <GitBranch />
                <span>{branch.name}</span>
                {branch.protected && (
                  <span className="badge neutral">
                    {t("protectedBranches")}
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </Modal>
      <Modal
        open={!!editingBranch}
        onClose={() => setEditingBranch(undefined)}
        title={`${t("branchOverrides")} · ${editingBranch?.name || ""}`}
        size="wide"
        footer={
          <>
            <button
              className="button ghost"
              onClick={() => setEditingBranch(undefined)}
            >
              {t("cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={saveBranch}
            >
              {busy ? <Spinner /> : t("save")}
            </button>
          </>
        }
      >
        {editingBranch && (
          <div className="two-column">
            <div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={inheritSchedule}
                  onChange={(e) => setInheritSchedule(e.target.checked)}
                />
                <b>{t("inheritSchedule")}</b>
              </label>
              {!inheritSchedule && editingBranch.schedule && (
                <ScheduleForm
                  value={editingBranch.schedule}
                  onChange={(v) =>
                    setEditingBranch({ ...editingBranch, schedule: v })
                  }
                />
              )}
            </div>
            <div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={inheritRetention}
                  onChange={(e) => setInheritRetention(e.target.checked)}
                />
                <b>{t("inheritRetention")}</b>
              </label>
              {!inheritRetention && editingBranch.retention && (
                <RetentionForm
                  value={editingBranch.retention}
                  onChange={(v) =>
                    setEditingBranch({ ...editingBranch, retention: v })
                  }
                />
              )}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={modal === "delete"}
        onClose={() => setModal(null)}
        title={t("deleteRepository")}
        footer={
          <>
            <button className="button ghost" onClick={() => setModal(null)}>
              {t("cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy || confirmation !== data.name}
              onClick={removeRepo}
            >
              {busy ? <Spinner /> : t("delete")}
            </button>
          </>
        }
      >
        <div className="warning-box">
          <AlertTriangle />
          <p>{t("deleteRepositoryWarning")}</p>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
          />
          <span>{t("deleteFilesToo")}</span>
        </label>
        <label>
          <span>
            {t("typeToConfirm")} · <b>{data.name}</b>
          </span>
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
      </Modal>
    </>
  );
}
