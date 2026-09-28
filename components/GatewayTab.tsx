import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';

import OmniWebview from './OmniWebview';
import ServerPill from './ServerPill';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

interface Props {
  path: string;
  title: string;
}

/**
 * A tab that renders one gateway feature. If the gateway has not been
 * configured yet, shows a short prompt pointing to the Home tab.
 */
export default function GatewayTab({ path, title }: Props) {
  const { settings, loaded } = useSettings();

  if (!loaded) return <View style={styles.empty} />;

  if (!settings.configured || !settings.serverUrl) {
    return (
      <View style={styles.empty}>
        <MaterialCommunityIcons name="web-off" size={40} color={theme.textMuted} />
        <Text style={styles.emptyTitle}>Connect your gateway first</Text>
        <Text style={styles.emptyText}>
          Open the Home tab to point OmniRoute Mobile at your gateway.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
          onPress={() => router.navigate('/')}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons name="home" size={18} color="#0b0f1a" />
          <Text style={styles.ctaLabel}>Go to Home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <ServerPill />
      <OmniWebview path={path} title={title} showBack={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  empty: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 10,
  },
  emptyTitle: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 8 },
  emptyText: { color: theme.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 11,
    marginTop: 12,
  },
  ctaLabel: { color: '#0b0f1a', fontWeight: '800', fontSize: 14 },
});
