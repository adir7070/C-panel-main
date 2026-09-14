import { useCallback, useEffect, useRef, useState } from "react";

interface State<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** `ApiError.code` from the server (e.g. "fb_unavailable"), when the
   *  failure carried one. Lets a screen tell "switched off" apart from
   *  "broke" without string-matching the message. */
  errorCode: string | null;
}

/**
 * Run an async fetcher when deps change. Aborts the in-flight request on
 * unmount or when deps change again, so stale results never overwrite fresh
 * state. The fetcher receives an AbortSignal — pass it through to fetch.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>
): State<T> & { reload: () => void } {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null, errorCode: null });
  const ctrlRef = useRef<AbortController | null>(null);
  const tickRef = useRef(0);

  // Keep latest fetcher in a ref so deps don't need to include it
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  const run = useCallback(() => {
    if (ctrlRef.current) ctrlRef.current.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const myTick = ++tickRef.current;
    setState(s => ({ ...s, loading: true, error: null, errorCode: null }));
    fetcherRef.current(ctrl.signal)
      .then(data => {
        if (myTick !== tickRef.current) return;
        setState({ data, loading: false, error: null, errorCode: null });
      })
      .catch(err => {
        if (ctrl.signal.aborted) return;
        if (myTick !== tickRef.current) return;
        setState({ data: null, loading: false, error: err?.message ?? "שגיאה", errorCode: (err as { code?: string })?.code ?? null });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    return () => { ctrlRef.current?.abort(); };
  }, [run]);

  return { ...state, reload: run };
}
