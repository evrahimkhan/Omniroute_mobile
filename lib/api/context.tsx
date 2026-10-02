/**
 * The app's one gateway client, plus the hooks screens fetch with.
 *
 * Screens do not build URLs. They call `useApi()` for a client bound to the
 * configured gateway, and `useResource()`/`usePolling()` to run a request — so
 * the base URL, the session cookie and the timeout live in exactly one place,
 * and a screen only has to say what it wants and what to render.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, createApi, type Api } from './client';
import { getAuthStatus, signIn as signInRequest, signOut as signOutRequest } from './auth';
import { useSettings } from '../useSettings';

const SESSION_KEY = 'omniroute.session.v1';

export interface SessionState {
  /** The dashboard session cookie, when the app has one. */
  cookie: string | null;
  /** Whether the gateway says the session (or loopback trust) is enough. */
  authenticated: boolean | null;
  /** Sign in and remember the cookie the gateway hands back. */
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-ask the gateway. */
  refresh: () => Promise<void>;
  checking: boolean;
}

interface ApiContextValue {
  api: Api | null;
  /** Why there is no client yet (settings still loading, or no URL saved). */
  waiting: boolean;
  session: SessionState;
  /** The last request's failure, for a screen that wants to explain one thing. */
  lastError: ApiError | null;
  setLastError: (error: ApiError | null) => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { settings, loaded } = useSettings();
  const [cookie, setCookie] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastError, setLastError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(SESSION_KEY);
        if (mounted.current && stored) setCookie(stored);
      } catch {
        // No stored session: the gateway may not need one.
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const persist = useCallback((next: string | null) => {
    setCookie(next);
    const write = next ? AsyncStorage.setItem(SESSION_KEY, next) : AsyncStorage.removeItem(SESSION_KEY);
    write.catch(() => {
      // A session that cannot be persisted is still usable for this run.
    });
  }, []);

  const api = useMemo(() => {
    if (!loaded || !settings.serverUrl) return null;
    return createApi({
      base: settings.serverUrl,
      sessionCookie: cookie,
      apiToken: settings.apiToken ?? null,
      onSession: (captured) => persist(captured),
    });
  }, [loaded, settings.serverUrl, settings.apiToken, cookie, persist]);

  const refresh = useCallback(async () => {
    if (!api) return;
    setChecking(true);
    try {
      const status = await getAuthStatus(api);
      if (mounted.current) setAuthenticated(status.authenticated);
    } catch (err) {
      // A gateway too old to have /api/auth/status is not a signed-out gateway:
      // leave the answer unknown rather than claiming a problem.
      if (mounted.current && err instanceof ApiError && err.status === 404) setAuthenticated(true);
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (password: string) => {
      if (!api) throw new Error('No gateway is configured yet');
      await signInRequest(api, password);
      setAuthenticated(true);
    },
    [api]
  );

  const signOut = useCallback(async () => {
    if (api) await signOutRequest(api).catch(() => undefined);
    persist(null);
    setAuthenticated(false);
  }, [api, persist]);

  const value = useMemo<ApiContextValue>(
    () => ({
      api,
      waiting: !loaded,
      session: { cookie, authenticated, signIn, signOut, refresh, checking },
      lastError,
      setLastError,
    }),
    [api, loaded, cookie, authenticated, signIn, signOut, refresh, checking, lastError]
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi() was used outside <ApiProvider>');
  return value;
}

/** The client, for screens that have already checked there is one. */
export function useApi(): Api {
  const { api } = useApiContext();
  if (!api) throw new Error('No gateway configured');
  return api;
}

export function useSession(): SessionState {
  return useApiContext().session;
}

/**
 * Turn an error into the one line a screen shows.
 *
 * Every branch here exists because it happened: a stopped gateway answered
 * nothing, a wrong scheme failed the handshake, a route wanted a session, and a
 * proxy returned an HTML page where JSON was expected.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.needsSignIn) {
      return `${error.message}\n\nThe gateway wants a dashboard session for this route. Sign in from Settings, or set an API token.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Run one request and keep its result.
 *
 * `deps` decides when to re-run, like `useEffect` — and the request is thrown
 * away if new deps arrive first, which is what stops a search box showing the
 * results of the query before last.
 */
export function useResource<T>(
  run: ((api: Api) => Promise<T>) | null,
  deps: unknown[],
  options: { enabled?: boolean } = {}
): Resource<T> {
  const enabled = options.enabled ?? true;
  const { api } = useApiContext();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(api && enabled));
  const runRef = useRef(run);
  runRef.current = run;
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!api || !runRef.current || !enabled) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const result = await runRef.current(api);
      if (generation.current === mine) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (generation.current === mine) setError(describeError(err));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [api, enabled, ...deps]);

  useEffect(() => {
    load();
    return () => {
      // Invalidate in-flight results from the previous deps.
      generation.current += 1;
    };
  }, [load]);

  return { data, error, loading, reload: load };
}

/**
 * A resource that refreshes on a timer.
 *
 * Polling is the honest choice for most of this API: the routes are request/
 * response with no subscription, and a phone screen that is open is exactly when
 * a user expects the numbers to move. `intervalMs` of 0 means "fetch once".
 */
export function usePolling<T>(
  run: ((api: Api) => Promise<T>) | null,
  intervalMs: number,
  deps: unknown[] = [],
  options: { enabled?: boolean } = {}
): Resource<T> {
  const resource = useResource(run, deps, options);
  const { reload } = resource;
  useEffect(() => {
    if (!intervalMs || !(options.enabled ?? true)) return;
    const timer = setInterval(() => {
      reload();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, reload, options.enabled]);
  return resource;
}
