import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { checkGateway, hostOf, type GatewayStatus } from '../lib/gateway';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

/**
 * Slim gateway status strip shown above the dashboard web views.
 * Re-probes the gateway every time the parent screen gains focus.
 */
export default function ServerPill() {
  const { settings } = useSettings();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setChecking(true);
      checkGateway(settings.serverUrl)
        .then((res) => {
          if (alive) setStatus(res);
        })
        .finally(() => {
          if (alive) setChecking(false);
        });
      return () => {
        alive = false;
      };
    }, [settings.serverUrl]),
  );

  const online = status?.ok === true;

  return (
    <Pressable
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.85 }]}
      onPress={() => router.push('/settings')}
      accessibilityRole="button"
      accessibilityLabel="Gateway status, tap to change server"
    >
      <View style={[styles.dot, online ? styles.dotOn : styles.dotOff]} />
      <Text style={styles.label} numberOfLines={1}>
        {hostOf(settings.serverUrl)}
      </Text>
      <Text style={styles.meta}>
        {checking
          ? 'checking…'
          : online
            ? status?.latencyMs != null
              ? `online · ${status.latencyMs} ms`
              : 'online'
            : status?.detail || 'offline'}
      </Text>
      <MaterialCommunityIcons name="chevron-right" size={16} color={theme.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.success },
  dotOff: { backgroundColor: theme.danger },
  label: { color: theme.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  meta: {
    color: theme.textMuted,
    fontSize: 11,
    flex: 1,
    textAlign: 'right',
    flexShrink: 1,
  },
});
