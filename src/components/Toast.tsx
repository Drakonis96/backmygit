import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Toast = {id:number;message:string;type:'success'|'error'};
const Context=createContext<(message:string,type?:Toast['type'])=>void>(()=>{});
export const useToast=()=>useContext(Context);
export function ToastProvider({children}:{children:ReactNode}){
  const {t}=useTranslation();
  const [items,setItems]=useState<Toast[]>([]);
  const show=useCallback((message:string,type:Toast['type']='success')=>{const id=Date.now()+Math.random();setItems(x=>[...x,{id,message,type}]);setTimeout(()=>setItems(x=>x.filter(t=>t.id!==id)),4500)},[]);
  const value=useMemo(()=>show,[show]);
  return <Context.Provider value={value}>{children}<div className="toast-stack" aria-live="polite">{items.map(item=><div className={`toast ${item.type}`} key={item.id}>{item.type==='success'?<CheckCircle2/>:<XCircle/>}<span>{item.message}</span><button aria-label={t('close')} onClick={()=>setItems(x=>x.filter(t=>t.id!==item.id))}><X/></button></div>)}</div></Context.Provider>
}
