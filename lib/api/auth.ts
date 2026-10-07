/**
 * The dashboard session, held by the app instead of by a WebView.
 *
 * A local gateway in bootstrap mode answers loopback requests without any
 * credentials — that is upstream's rule, and it is why the phone's dashboard
 * worked without anyone signing in. The moment a management password exists, the
 * data routes answer 401 until a dashboard session cookie is presented, and
 * React Native's fetch has no cookie jar: the cookie has to be captured from the
 * login response and replayed.
 *
 * That is what this module does, and nothing more. It is deliberately small
 * because the *normal* case on this phone is "no password, nothing to do" — the
 * sign-in screen exists so that a user who sets a password is not locked out of
 * their own gateway, not because signing in is expected.
 */

import type { Api } from './client';
import { asRecord, pickBool, type Json } from './shape';

export interface AuthStatus {
  authenticated: boolean;
  /** Present when the gateway exposes its setup state (bootstrap mode). */
  setupRequired: boolean;
  raw: Json | null;
}

export async function getAuthStatus(api: Api): Promise<AuthStatus> {
  const raw = asRecord(await api.get<unknown>('/api/auth/status'));
  return {
    authenticated: pickBool(raw, 'authenticated', 'loggedIn', 'ok') ?? false,
    setupRequired: pickBool(raw, 'setupRequired', 'needsSetup', 'bootstrapMode') ?? false,
    raw,
  };
}

/**
 * Sign in with the management password. The session cookie is delivered to
 * `ApiOptions.onSession` (see `client.ts`), so this returns nothing to keep.
 */
export async function signIn(api: Api, password: string): Promise<void> {
  await api.post<unknown>('/api/auth/login', { password });
}

export async function signOut(api: Api): Promise<void> {
  await api.post<unknown>('/api/auth/logout', {});
}

/**
 * What to say when the gateway refused a request for want of a session.
 *
 * The distinction matters on a phone: a 401 from a local gateway means "a
 * password was set", while a 403 usually means the route is local-only and the
 * URL is not actually loopback (a tunnel, or a LAN address) — advice that has
 * nothing in common.
 */
export function explainAuthFailure(status: number | null, url: string): string {
  if (status === 401) {
    return `The gateway at ${url} wants a dashboard session. Open Settings and sign in with the management password.`;
  }
  if (status === 403) {
    return `The gateway at ${url} refused this request: that route is local-only, and this address is not the device itself. Use http://127.0.0.1:8080 to reach the gateway running on this phone.`;
  }
  return `The gateway at ${url} refused this request.`;
}
