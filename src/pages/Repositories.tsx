import { Database, GitBranch, MoreHorizontal, Plus, Search, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatBytes, mutate } from '../api';
import { Card, Empty, PageHeader, StatusBadge } from '../components/UI';
import { useApi } from '../hooks';
import { useToast } from '../components/Toast';
import type { Repository } from '../types';

export default function Repositories(){const{t,i18n}=useTranslation();const toast=useToast();const{data,loading,refresh}=useApi<{items:Repository[]}>('/repositories',15000);const[query,setQuery]=useState('');
  const items=useMemo(()=>data?.items.filter(r=>`${r.owner}/${r.name} ${r.description}`.toLowerCase().includes(query.toLowerCase()))||[],[data,query]);const date=(v?:string)=>v?new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'—';
  const run=async(repo:Repository)=>{try{await mutate('/backups/run','POST',{repositoryId:repo.id});toast(t('requestQueued'));void refresh()}catch{toast(t('unexpectedError'),'error')}};
  return <><PageHeader title={t('repositories')} description={t('protectedRepositories')} actions={<Link className="button primary" to="/repositories/new"><Plus/>{t('addRepositories')}</Link>}/><div className="toolbar"><label className="search-field"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('search')} aria-label={t('search')}/></label><span>{items.length} {t('repositories').toLowerCase()}</span></div>
    {loading?<div className="repo-grid">{[1,2,3].map(x=><div className="card repo-card skeleton" key={x}/>)}</div>:!items.length?<Card><Empty icon={<ShieldCheck/>} title={t('noRepositories')} text={t('getStarted')} action={<Link className="button primary" to="/repositories/new"><Plus/>{t('addRepositories')}</Link>}/></Card>:<div className="repo-grid">{items.map(repo=><Card className="repo-card" key={repo.id}><div className="repo-top"><div className="repo-icon"><GitBranch/></div><StatusBadge status={!repo.enabled?'disabled':repo.lastStatus==='failed'?'failed':'healthy'}/></div><div className="repo-name"><span>{repo.owner}</span><Link to={`/repositories/${repo.id}`}>{repo.name}</Link></div><p>{repo.description||t('noDescription')}</p><div className="repo-stats"><div><b>{repo.branchCount}</b><span>{t('branches')}</span></div><div><b>{repo.backupCount}</b><span>{t('backups')}</span></div><div><b>{formatBytes(repo.sizeBytes)}</b><span>{t('storage')}</span></div></div><div className="repo-times"><div><span>{t('lastBackup')}</span><b>{date(repo.lastBackup)}</b></div><div><span>{t('nextScheduled')}</span><b>{date(repo.nextBackup)}</b></div></div><div className="repo-actions"><button className="button secondary" onClick={()=>run(repo)} disabled={!repo.enabled}><Database/>{t('backupNow')}</button><Link className="icon-button" to={`/repositories/${repo.id}`} title={t('view')}><MoreHorizontal/></Link></div></Card>)}</div>}
  </>}
