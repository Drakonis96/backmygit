import { ArrowUp, Check, Cloud, Folder, HardDrive, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, mutate } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { Card, Empty, Loading, Modal, PageHeader, StatusBadge } from '../components/UI';
import { useApi } from '../hooks';

type Connection = {
  id: string; name: string; provider: string; remoteName: string; authType: string; status: string;
  managed: boolean; lastTestedAt?: string; lastError?: string; targetCount: number;
};
type Target = {
  id: string; connectionId?: string; kind: 'local' | 'rclone'; name: string; rootPath: string;
  encryptionMode: 'none' | 'crypt'; enabled: boolean; connectionName?: string; provider?: string;
  connectionStatus?: string; assignmentCount: number;
};
type FolderItem = { name: string; path: string; id?: string };
type Transfer = {
  id: string; status: string; attempts: number; bytes_total?: number; bytes_transferred: number; speed_bps?: number;
  error?: string; target_name: string; connection_name: string; owner: string; repository: string; branch: string; commit_sha: string;
};

const emptyConnection = { name: '', provider: 'external', remoteName: '', username: '', password: '', accessKeyId: '', secretAccessKey: '', endpoint: '', region: '', s3Provider: 'Other' };

export default function Destinations() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'admin';
  const connections = useApi<{ items: Connection[] }>('/cloud/connections', 15_000);
  const targets = useApi<{ items: Target[] }>('/cloud/targets', 15_000);
  const assignments = useApi<{ targetIds: string[] }>('/cloud/assignments/global');
  const transfers = useApi<{ items: Transfer[] }>('/cloud/transfers?limit=50', 3_000);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionForm, setConnectionForm] = useState(emptyConnection);
  const [targetConnection, setTargetConnection] = useState<Connection>();
  const [targetForm, setTargetForm] = useState({ name: '', rootPath: '', encryptionMode: 'crypt' as 'none' | 'crypt' });
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (assignments.data) setSelected(assignments.data.targetIds); }, [assignments.data]);
  const refresh = async () => Promise.all([connections.refresh(), targets.refresh(), assignments.refresh(), transfers.refresh()]);
  const fail = (caught: unknown) => {
    const message = caught instanceof ApiError ? caught.message : t('unexpectedError');
    setError(message); toast(message, 'error');
  };

  const createConnection = async () => {
    setBusy(true); setError('');
    try {
      const credentials = connectionForm.provider === 'mega'
        ? { username: connectionForm.username, password: connectionForm.password }
        : connectionForm.provider === 's3'
          ? { accessKeyId: connectionForm.accessKeyId, secretAccessKey: connectionForm.secretAccessKey, endpoint: connectionForm.endpoint || undefined, region: connectionForm.region || undefined, provider: connectionForm.s3Provider }
          : {};
      await mutate('/cloud/connections', 'POST', {
        name: connectionForm.name,
        provider: connectionForm.provider,
        remoteName: connectionForm.remoteName || undefined,
        credentials,
      });
      setConnectionOpen(false); setConnectionForm(emptyConnection); toast(t('connectionCreated')); await refresh();
    } catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const testConnection = async (connection: Connection) => {
    setBusy(true); setError('');
    try { await mutate(`/cloud/connections/${connection.id}/test`, 'POST'); toast(t('connectionVerified')); await connections.refresh(); }
    catch (caught) { fail(caught); await connections.refresh(); } finally { setBusy(false); }
  };
  const deleteConnection = async (connection: Connection) => {
    if (!window.confirm(t('deleteConnectionConfirm'))) return;
    setBusy(true); try { await mutate(`/cloud/connections/${connection.id}`, 'DELETE'); await refresh(); }
    catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const openTarget = (connection: Connection) => {
    setTargetConnection(connection);
    setTargetForm({ name: `${connection.name} ${t('destination')}`, rootPath: 'BackMyGit', encryptionMode: 'crypt' });
    setError('');
  };
  const loadFolders = async (path: string) => {
    if (!targetConnection) return;
    setBrowseBusy(true); setError('');
    try {
      const response = await api<{ path: string; items: FolderItem[] }>(`/cloud/connections/${targetConnection.id}/browse?path=${encodeURIComponent(path)}`);
      setBrowsePath(response.path); setFolders(response.items);
    } catch (caught) { fail(caught); } finally { setBrowseBusy(false); }
  };
  const openBrowser = async () => { setBrowsePath(''); setFolders([]); setBrowseOpen(true); await loadFolders(''); };
  const createTarget = async () => {
    if (!targetConnection) return;
    setBusy(true); setError('');
    try {
      await mutate('/cloud/targets', 'POST', { connectionId: targetConnection.id, ...targetForm });
      setTargetConnection(undefined); toast(t('destinationCreated')); await refresh();
    } catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const deleteTarget = async (target: Target) => {
    if (!window.confirm(t('deleteDestinationConfirm'))) return;
    setBusy(true); try { await mutate(`/cloud/targets/${target.id}`, 'DELETE'); await refresh(); }
    catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const saveAssignments = async () => {
    setBusy(true); setError('');
    try { await mutate('/cloud/assignments/global', 'PUT', { targetIds: selected }); toast(t('destinationsSaved')); await refresh(); }
    catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const retry = async (transfer: Transfer) => {
    setBusy(true); setError('');
    try { await mutate(`/cloud/transfers/${transfer.id}/retry`, 'POST'); toast(t('transferQueued')); await transfers.refresh(); }
    catch (caught) { fail(caught); } finally { setBusy(false); }
  };

  if (connections.loading || targets.loading || assignments.loading) return <Loading />;
  return <>
    <PageHeader title={t('cloudDestinations')} description={t('cloudDestinationsHelp')} actions={canManage ? <button className="button primary" onClick={() => { setError(''); setConnectionOpen(true); }}><Plus />{t('addConnection')}</button> : undefined} />
    {error && <div className="alert-banner"><Cloud /><div><b>{t('cloudOperationFailed')}</b><span>{error}</span></div></div>}
    <Card title={t('connections')}>
      {!connections.data?.items.length ? <Empty icon={<Cloud />} title={t('noConnections')} text={t('noConnectionsHelp')} /> : <div className="destination-grid">
        {connections.data.items.map(connection => <article className="destination-card" key={connection.id}>
          <div className="destination-card-head"><span className="provider-icon"><Cloud /></span><div><b>{connection.name}</b><small>{connection.provider} · {connection.remoteName}</small></div><StatusBadge status={connection.status} /></div>
          {connection.lastError && <p className="connection-error">{connection.lastError}</p>}
          {canManage && <div className="destination-actions"><button className="button secondary" disabled={busy} onClick={() => testConnection(connection)}><RefreshCw />{t('testConnection')}</button><button className="button secondary" disabled={busy || connection.status !== 'connected'} onClick={() => openTarget(connection)}><Plus />{t('addDestination')}</button><button className="icon-button danger" disabled={busy || connection.targetCount > 0} onClick={() => deleteConnection(connection)} title={t('delete')}><Trash2 /></button></div>}
        </article>)}
      </div>}
    </Card>
    <Card title={t('backupDestinations')} actions={canManage ? <button className="button primary" disabled={busy} onClick={saveAssignments}><Check />{t('saveDestinations')}</button> : undefined}>
      <p className="help-text destination-help">{t('multiDestinationHelp')}</p>
      <div className="target-list">
        {targets.data?.items.map(target => <label className={`target-row ${target.kind === 'local' ? 'local' : ''}`} key={target.id}>
          <input type="checkbox" checked={target.kind === 'local' || selected.includes(target.id)} disabled={!canManage || target.kind === 'local' || !target.enabled || target.connectionStatus !== 'connected'} onChange={event => setSelected(current => event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id))} />
          <span className="target-icon">{target.kind === 'local' ? <HardDrive /> : <Cloud />}</span>
          <span className="target-main"><b>{target.name}</b><small>{target.kind === 'local' ? t('alwaysLocal') : `${target.connectionName} · ${target.rootPath || '/'}`}</small></span>
          {target.encryptionMode === 'crypt' && <span className="encryption-label"><ShieldCheck />{t('encrypted')}</span>}
          {canManage && target.kind === 'rclone' && <button type="button" className="icon-button danger" disabled={busy} onClick={event => { event.preventDefault(); void deleteTarget(target); }} title={t('delete')}><Trash2 /></button>}
        </label>)}
      </div>
    </Card>

    <Card title={t('replicationActivity')}>
      {!transfers.data?.items.length ? <Empty icon={<RefreshCw />} title={t('noTransfers')} text={t('noTransfersHelp')} /> : <div className="transfer-list">
        {transfers.data.items.map(transfer => {
          const total = transfer.bytes_total || 0;
          const percent = total ? Math.min(100, transfer.bytes_transferred / total * 100) : 0;
          return <div className="transfer-row" key={transfer.id}><span className="target-icon"><Cloud /></span><span className="transfer-main"><b>{transfer.owner}/{transfer.repository} · {transfer.branch}</b><small>{transfer.target_name} · {transfer.commit_sha.slice(0, 8)} · {t('attempt')} {transfer.attempts}</small><i><em style={{ width: `${percent}%` }} /></i>{transfer.error && <small className="transfer-error">{transfer.error}</small>}</span><span className="transfer-state"><StatusBadge status={transfer.status} />{canManage && transfer.status === 'failed' && <button className="button secondary" disabled={busy} onClick={() => void retry(transfer)}>{t('retryTransfer')}</button>}</span></div>;
        })}
      </div>}
    </Card>

    <Modal open={connectionOpen} onClose={() => setConnectionOpen(false)} title={t('addConnection')} footer={<><button className="button secondary" onClick={() => setConnectionOpen(false)}>{t('cancel')}</button><button className="button primary" disabled={busy} onClick={createConnection}>{busy ? t('saving') : t('createConnection')}</button></>}>
      <div className="form-grid cloud-form">
        <label><span>{t('connectionName')}</span><input value={connectionForm.name} maxLength={100} onChange={event => setConnectionForm({ ...connectionForm, name: event.target.value })} /></label>
        <label><span>{t('provider')}</span><select value={connectionForm.provider} onChange={event => setConnectionForm({ ...emptyConnection, name: connectionForm.name, provider: event.target.value })}><option value="external">{t('existingRclone')}</option><option value="mega">MEGA</option><option value="s3">S3</option><option value="drive">Google Drive (OAuth)</option><option value="dropbox">Dropbox (OAuth)</option><option value="onedrive">OneDrive (OAuth)</option></select></label>
        {connectionForm.provider === 'external' && <label className="full"><span>{t('remoteName')}</span><input value={connectionForm.remoteName} onChange={event => setConnectionForm({ ...connectionForm, remoteName: event.target.value })} placeholder="my_remote" /></label>}
        {connectionForm.provider === 'mega' && <><label><span>{t('username')}</span><input type="email" autoComplete="username" value={connectionForm.username} onChange={event => setConnectionForm({ ...connectionForm, username: event.target.value })} /></label><label><span>{t('password')}</span><input type="password" autoComplete="new-password" value={connectionForm.password} onChange={event => setConnectionForm({ ...connectionForm, password: event.target.value })} /></label></>}
        {connectionForm.provider === 's3' && <><label><span>{t('accessKeyId')}</span><input autoComplete="off" value={connectionForm.accessKeyId} onChange={event => setConnectionForm({ ...connectionForm, accessKeyId: event.target.value })} /></label><label><span>{t('secretAccessKey')}</span><input type="password" autoComplete="new-password" value={connectionForm.secretAccessKey} onChange={event => setConnectionForm({ ...connectionForm, secretAccessKey: event.target.value })} /></label><label className="full"><span>{t('endpointOptional')}</span><input type="url" value={connectionForm.endpoint} onChange={event => setConnectionForm({ ...connectionForm, endpoint: event.target.value })} placeholder="https://s3.example.com" /></label><label><span>{t('regionOptional')}</span><input value={connectionForm.region} onChange={event => setConnectionForm({ ...connectionForm, region: event.target.value })} /></label><label><span>{t('s3Provider')}</span><input value={connectionForm.s3Provider} onChange={event => setConnectionForm({ ...connectionForm, s3Provider: event.target.value })} /></label></>}
        {['drive', 'dropbox', 'onedrive'].includes(connectionForm.provider) && <div className="full oauth-note">{t('oauthConfiguredNext')}</div>}
      </div>
    </Modal>

    <Modal open={Boolean(targetConnection)} onClose={() => setTargetConnection(undefined)} title={t('addDestination')} footer={<><button className="button secondary" onClick={() => setTargetConnection(undefined)}>{t('cancel')}</button><button className="button primary" disabled={busy} onClick={createTarget}>{t('createDestination')}</button></>}>
      <div className="form-grid cloud-form"><label className="full"><span>{t('destinationName')}</span><input value={targetForm.name} onChange={event => setTargetForm({ ...targetForm, name: event.target.value })} /></label><label className="full"><span>{t('remoteFolder')}</span><div className="folder-input"><input value={targetForm.rootPath} onChange={event => setTargetForm({ ...targetForm, rootPath: event.target.value })} /><button className="button secondary" onClick={() => void openBrowser()}><Folder />{t('browse')}</button></div></label><label className="toggle-field full"><span><b>{t('clientSideEncryption')}</b><small>{t('encryptionHelp')}</small></span><input type="checkbox" checked={targetForm.encryptionMode === 'crypt'} onChange={event => setTargetForm({ ...targetForm, encryptionMode: event.target.checked ? 'crypt' : 'none' })} /><i /></label></div>
    </Modal>

    <Modal open={browseOpen} onClose={() => setBrowseOpen(false)} title={t('chooseRemoteFolder')} footer={<><button className="button secondary" onClick={() => setBrowseOpen(false)}>{t('cancel')}</button><button className="button primary" onClick={() => { setTargetForm({ ...targetForm, rootPath: browsePath }); setBrowseOpen(false); }}>{t('selectThisFolder')}</button></>}>
      <div className="folder-browser"><code>/{browsePath}</code><button className="folder-row" disabled={!browsePath || browseBusy} onClick={() => void loadFolders(browsePath.split('/').slice(0, -1).join('/'))}><ArrowUp /><span>{t('parentFolder')}</span></button>{browseBusy ? <Loading /> : folders.map(folder => <button className="folder-row" key={`${folder.id || ''}-${folder.path}`} onClick={() => void loadFolders(folder.path)}><Folder /><span>{folder.name}</span></button>)}</div>
    </Modal>
  </>;
}
