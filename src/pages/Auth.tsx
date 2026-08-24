import { Boxes, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { Spinner } from '../components/UI';

export function AuthLoading() {
  return <div className="auth-shell"><div className="auth-card auth-loading"><Spinner /></div></div>;
}

function AuthBrand() {
  return <div className="auth-brand"><span><Boxes /></span><div><b>BackMyGit</b><small>Repository protection</small></div></div>;
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await login(username, password); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : t('unexpectedError')); }
    finally { setBusy(false); }
  };
  return <div className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <AuthBrand />
    <div className="auth-icon"><LogIn /></div>
    <h1>{t('signIn')}</h1><p>{t('signInHelp')}</p>
    <label>{t('username')}<input autoComplete="username" autoFocus value={username} onChange={e=>setUsername(e.target.value)} required /></label>
    <label>{t('password')}<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>
    {error && <div className="field-error">{error}</div>}
    <button className="button primary" disabled={busy}>{busy?<Spinner/>:<LogIn/>}{t('signIn')}</button>
  </form></div>;
}

export function SetupPage() {
  const { t } = useTranslation();
  const { setup } = useAuth();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (password !== confirm) { setError(t('passwordsDoNotMatch')); return; }
    setBusy(true);
    try { await setup(token, username, password); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : t('unexpectedError')); }
    finally { setBusy(false); }
  };
  return <div className="auth-shell"><form className="auth-card setup-card" onSubmit={submit}>
    <AuthBrand />
    <div className="auth-icon"><ShieldCheck /></div>
    <h1>{t('secureSetup')}</h1><p>{t('secureSetupHelp')}</p>
    <div className="setup-note"><KeyRound/><span>{t('bootstrapTokenHelp')}<code>docker compose exec app cat /data/bootstrap-token</code></span></div>
    <label>{t('bootstrapToken')}<input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required /></label>
    <label>{t('username')}<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} minLength={3} required /></label>
    <label>{t('password')}<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} required /></label>
    <label>{t('confirmPassword')}<input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} minLength={12} required /></label>
    {error && <div className="field-error">{error}</div>}
    <button className="button primary" disabled={busy}>{busy?<Spinner/>:<ShieldCheck/>}{t('createAdministrator')}</button>
  </form></div>;
}
