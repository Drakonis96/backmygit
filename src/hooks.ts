import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export function useApi<T>(url: string | null, refreshMs = 0) {
  const [data,setData] = useState<T>(); const [loading,setLoading] = useState(true); const [error,setError] = useState<Error>();
  const refresh = useCallback(async () => {
    if (!url) return;
    try { setError(undefined); setData(await api<T>(url)); } catch (e) { setError(e as Error); } finally { setLoading(false); }
  },[url]);
  useEffect(() => { setLoading(true); void refresh(); if (!refreshMs) return; const timer=setInterval(refresh,refreshMs); return()=>clearInterval(timer); },[refresh,refreshMs]);
  return { data,loading,error,refresh,setData };
}

export function useDebounce<T>(value:T, delay=350) {
  const [debounced,setDebounced]=useState(value);
  useEffect(()=>{const timer=setTimeout(()=>setDebounced(value),delay);return()=>clearTimeout(timer)},[value,delay]);
  return debounced;
}
