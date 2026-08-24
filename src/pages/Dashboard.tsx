import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Database, GitBranch, HardDrive, Plus, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatBytes } from '../api';
import { Card, Empty, PageHeader, StatusBadge } from '../components/UI';
import { useApi } from '../hooks';
import type { Run } from '../types';

type Data={counts:{protectedRepositories:number;protectedBranches:number;totalBackups:number;successfulBackups:number;failedBackups:number;totalBytes:number;lastCompleted?:string;nextScheduled?:string};recent:Run[];attention:Array<{id:number;owner:string;name:string;enabled:number;lastStatus?:string}>};
export default function Dashboard(){const{t,i18n}=useTranslation();const{data,loading}=useApi<Data>('/dashboard',10000);const date=(v?:string)=>v?new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'—';
  const metrics=data?[{key:'protectedRepositories',value:data.counts.protectedRepositories,icon:ShieldCheck},{key:'protectedBranches',value:data.counts.protectedBranches,icon:GitBranch},{key:'totalBackups',value:data.counts.totalBackups,icon:Database},{key:'diskUsed',value:formatBytes(data.counts.totalBytes),icon:HardDrive}]:[];
  return <><PageHeader title={t('dashboard')} description={t('overview')} actions={<Link className="button primary" to="/repositories/new"><Plus/>{t('addRepositories')}</Link>}/>
    {loading?<div className="metric-grid">{[1,2,3,4].map(x=><div className="card metric skeleton" key={x}/>)}</div>:<div className="metric-grid">{metrics.map(({key,value,icon:Icon})=><Card className="metric" key={key}><div className="metric-icon"><Icon/></div><div><span>{t(key as any)}</span><strong>{value}</strong></div></Card>)}</div>}
    <div className="insight-strip"><div><CheckCircle2/><span>{t('successfulBackups')}</span><b>{data?.counts.successfulBackups||0}</b></div><div><AlertTriangle/><span>{t('failedBackups')}</span><b>{data?.counts.failedBackups||0}</b></div><div><Clock3/><span>{t('lastCompleted')}</span><b>{date(data?.counts.lastCompleted)}</b></div><div><Clock3/><span>{t('nextScheduled')}</span><b>{date(data?.counts.nextScheduled)}</b></div></div>
    <div className="two-column"><Card title={t('recentActivity')} actions={<Link className="text-link" to="/history">{t('view')} <ArrowRight/></Link>}>
      {!data?.recent.length?<Empty icon={<Clock3/>} title={t('noRuns')}/>:<div className="activity-list">{data.recent.map(run=><div className="activity" key={run.id}><div className={`activity-icon status-${run.status}`}><GitBranch/></div><div className="activity-main"><b>{run.owner}/{run.repository}</b><span>{run.branch} · {t(run.origin)}</span></div><div className="activity-meta"><StatusBadge status={run.status}/><time>{date(run.completed_at||run.created_at)}</time></div></div>)}</div>}
    </Card><Card title={t('requiresAttention')}>{!data?.attention.length?<Empty icon={<ShieldCheck/>} title={t('allHealthy')}/>:<div className="attention-list">{data.attention.map(repo=><Link to={`/repositories/${repo.id}`} key={repo.id}><div><b>{repo.owner}/{repo.name}</b><span>{repo.enabled?t('attentionFailed'):t('attentionDisabled')}</span></div><ArrowRight/></Link>)}</div>}</Card></div>
  </>}
