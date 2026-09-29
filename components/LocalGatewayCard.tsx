import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import {
  LOCAL_GATEWAY_URL,
  gatewayLogTail,
  gatewayProgress,
  gatewayState,
  isLocalGatewaySupported,
  localGatewayUnavailableReason,
  startLocalGateway,
  uninstallLocalGateway,
  waitForLocalGateway,
  type GatewayProgress,
  type GatewayState,
} from '../lib/gatewayInstaller';
import { theme } from '../lib/theme';

interface Props {
  /** Called with the local URL once the gateway is up, to point the app at it. */
  onUse: (url: string) => void;
}

/**
 * "Local gateway" card: install OmniRoute on this phone and run it here.
 *
 * Everything it shows comes from `lib/gatewayInstaller.ts`; the only local state
 * is "am I mid-action" and the last error. The runtime's own log is the progress
 * channel, because that is the only one the embedded runtime has.
 */
export default function LocalGatewayCard({ onUse }: Props) {
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const cancelled = useRef(false);

  const supported = isLocalGatewaySupported();
  const unavailableReason = supported ? null : localGatewayUnavailableReason();

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setState(await gatewayState());
    } catch {
      // State is best-effort; a failed read must not blank the card.
    }
  }, [supported]);

  useEffect(() => {
    refresh();
    // While the runtime is up but not yet serving, keep looking — the install
    // can take a while and the log is how it reports in.
    const timer = setInterval(() => {
      if (!supported) return;
      refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, supported]);

  const phase = state?.phase ?? 'idle';
  const progress: GatewayProgress | null = state?.logTail ? gatewayProgress(state.logTail) : null;
  const working = phase === 'installing' || phase === 'starting';

  const install = async () => {
    setError(null);
    setBusy(true);
    cancelled.current = false;
    try {
      if (!state?.installed) {
        // A first run downloads the payload over the network.
        setWaiting(true);
      }
      await startLocalGateway();
      setWaiting(true);
      const url = await waitForLocalGateway({
        onProgress: (next) => setState(next),
        shouldContinue: () => !cancelled.current,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await refresh();
      onUse(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cancelling the wait is not a failure — the install carries on in the
      // background, so say that rather than showing an error.
      if (message === 'Cancelled') {
        await refresh();
      } else {
        setError(message);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      }
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  };

  const use = async () => {
    await refresh();
    onUse(LOCAL_GATEWAY_URL);
  };

  const remove = () => {
    Alert.alert(
      'Remove the local gateway?',
      'Deletes the downloaded gateway from this phone. Your dashboard data and sign-in are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await uninstallLocalGateway();
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const statusLine = (): { icon: 'check-circle' | 'alert-circle' | 'progress-clock' | 'cloud-download'; text: string; tone: 'ok' | 'warn' | 'muted' } => {
    if (phase === 'ready') {
      return { icon: 'check-circle', text: 'Running on this phone', tone: 'ok' };
    }
    if (phase === 'failed') {
      return { icon: 'alert-circle', text: 'Stopped', tone: 'warn' };
    }
    if (working) {
      return { icon: 'progress-clock', text: progress?.label ?? 'Working…', tone: 'muted' };
    }
    if (state?.installed) {
      return { icon: 'cloud-download', text: 'Installed — not running', tone: 'muted' };
    }
    return { icon: 'cloud-download', text: 'Not installed', tone: 'muted' };
  };
  const status = statusLine();

  const toneColor =
    status.tone === 'ok' ? theme.success : status.tone === 'warn' ? theme.danger : theme.textMuted;

  if (!supported) {
    return (
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.title}>Host it on this phone</Text>
          <MaterialCommunityIcons name="cellphone-off" size={18} color={theme.textMuted} />
        </View>
        <Text style={styles.note}>{unavailableReason}</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.title}>Host it on this phone</Text>
        <View style={styles.pill}>
          <MaterialCommunityIcons name="android" size={13} color={theme.textMuted} />
          <Text style={styles.pillText}>Android</Text>
        </View>
      </View>

      <View style={styles.statusRow}>
        {working && !busy ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : (
          <MaterialCommunityIcons name={status.icon} size={16} color={toneColor} />
        )}
        <Text style={[styles.statusText, { color: toneColor }]}>{status.text}</Text>
      </View>

      {working && progress?.detail ? <Text style={styles.detail}>{progress.detail}</Text> : null}
      {phase === 'ready' ? <Text style={styles.detail}>{LOCAL_GATEWAY_URL}</Text> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.row}>
        {phase === 'ready' ? (
          <>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
              onPress={use}
              disabled={busy}
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="check" size={17} color="#0b0f1a" />
              <Text style={styles.btnLabelDark}>Use this gateway</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.pressed]}
              onPress={remove}
              disabled={busy}
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="delete-outline" size={17} color={theme.text} />
              <Text style={styles.btnLabel}>Remove</Text>
            </Pressable>
          </>
        ) : working ? (
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.pressed]}
            onPress={() => {
              cancelled.current = true;
              setWaiting(false);
            }}
            accessibilityRole="button"
          >
            <MaterialCommunityIcons name="close" size={17} color={theme.text} />
            <Text style={styles.btnLabel}>Stop waiting</Text>
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
            onPress={install}
            disabled={busy || waiting}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator size="small" color="#0b0f1a" />
            ) : (
              <MaterialCommunityIcons name="download" size={17} color="#0b0f1a" />
            )}
            <Text style={styles.btnLabelDark}>
              {state?.installed ? 'Start the gateway' : 'Install & start'}
            </Text>
          </Pressable>
        )}
      </View>

      {phase === 'idle' && !state?.installed ? (
        <Text style={styles.note}>
          Downloads the gateway once, then runs it here — no server, no computer. Use Wi-Fi:
          it is a large download, and it needs room on the phone.
        </Text>
      ) : null}

      {phase === 'failed' ? (
        <Text style={styles.note}>
          Close and reopen the app to try again — the embedded runtime can only start once per
          app session. That is a limitation of the runtime, not of the gateway.
        </Text>
      ) : null}

      {phase === 'ready' ? (
        <Text style={styles.note}>
          Some features stay unavailable on a phone: image processing, browser automation,
          and anything that spawns a process. The gateway notes them rather than failing.
        </Text>
      ) : null}

      {state?.logTail ? (
        <Pressable
          style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
          onPress={() => setShowLog((v) => !v)}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name={showLog ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={theme.textMuted}
          />
          <Text style={styles.linkLabel}>{showLog ? 'Hide' : 'Show'} the gateway log</Text>
        </Pressable>
      ) : null}
      {showLog && state?.logTail ? (
        <Text style={styles.log}>{gatewayLogTail(state.logTail, 14)}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    gap: 10,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 15, fontWeight: '700' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  pillText: { color: theme.textMuted, fontSize: 11, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusText: { fontSize: 13, fontWeight: '700' },
  detail: { color: theme.textMuted, fontSize: 12 },
  error: { color: theme.danger, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnSecondary: { backgroundColor: theme.bg },
  pressed: { opacity: 0.85 },
  btnLabel: { color: theme.text, fontWeight: '700', fontSize: 13 },
  btnLabelDark: { color: '#0b0f1a', fontWeight: '800', fontSize: 13 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  linkLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  log: {
    color: theme.textMuted,
    fontSize: 11,
    lineHeight: 15,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 10,
    fontFamily: 'monospace',
  },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
});
