import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { repairServerUrl } from './serverUrl';

export interface Settings {
  /** Base URL of the OmniRoute gateway (no trailing slash). */
  serverUrl: string;
  /** Whether the user has explicitly saved a gateway. */
  configured: boolean;
  /**
   * An OmniRoute API key, sent as a bearer token.
   *
   * Needed only when the gateway is not trusted as local: a LAN or tunnel
   * address is treated as a remote client and must authenticate. Loopback does
   * not need one, which is why this is optional.
   */
  apiToken?: string;
}

export const DEFAULT_SERVER_URL = 'https://omniroute.online';

const KEY = 'omniroute.settings.v1';

function defaults(): Settings {
  return { serverUrl: DEFAULT_SERVER_URL, configured: false };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(defaults());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (alive && raw) {
          const parsed = JSON.parse(raw) as Partial<Settings>;
          const configured = Boolean(parsed.configured);
          // Repair on the way in: a URL stored before the scheme rule existed
          // (https to loopback) can never work, and the screen that would let
          // you fix it sits behind the gate that URL cannot pass.
          const saved = parsed.serverUrl || DEFAULT_SERVER_URL;
          const serverUrl = repairServerUrl(saved);
          setSettings({ serverUrl, configured, apiToken: parsed.apiToken });
          if (serverUrl !== saved) {
            AsyncStorage.setItem(KEY, JSON.stringify({ serverUrl, configured, apiToken: parsed.apiToken })).catch(
              () => {}
            );
          }
        }
      } catch {
        // Corrupt storage — fall through to defaults.
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (next: Settings) => {
    setSettings(next);
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Non-fatal: app keeps working with in-memory settings.
    }
  }, []);

  const reset = useCallback(async () => {
    const d = defaults();
    setSettings(d);
    try {
      await AsyncStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  }, []);

  return { settings, loaded, save, reset };
}
