import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { theme } from '../lib/theme';

/**
 * The app's own header for a pushed screen.
 *
 * It replaces the tab bar's hidden header on purpose: the gateway's name is the
 * one piece of context a user needs on every screen (this app can be pointed at
 * a gateway on the phone or one on a tunnel), and a native back button means the
 * Android hardware back gesture and the on-screen one do the same thing.
 */
export default function ScreenHeader({
  title,
  subtitle,
  right,
  onBack,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: Math.max(insets.top, 10) }]}>
      <Pressable
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.navigate('/')))}
        hitSlop={12}
        style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <MaterialCommunityIcons name="arrow-left" size={23} color={theme.text} />
      </Pressable>
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? <View style={styles.btn} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: theme.tabBarBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  btn: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: theme.surfaceAlt },
  titles: { flex: 1, gap: 1 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 11 },
});
