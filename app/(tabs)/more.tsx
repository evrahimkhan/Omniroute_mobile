import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { openURL } from 'expo-linking';
import { router } from 'expo-router';

import {
  FEATURE_SECTIONS,
  TOTAL_FEATURE_COUNT,
  isExternal,
  type FeatureItem,
} from '../../lib/features';
import { useSettings } from '../../lib/useSettings';
import { theme } from '../../lib/theme';

type Row =
  | { kind: 'section'; id: string; title: string }
  | { kind: 'group'; id: string; title: string }
  | { kind: 'item'; id: string; feature: FeatureItem; sectionTitle: string };

function buildRows(query: string): Row[] {
  const q = query.trim().toLowerCase();
  const rows: Row[] = [];
  for (const section of FEATURE_SECTIONS) {
    const sectionRows: Row[] = [];
    for (const group of section.groups) {
      const items = group.items.filter(
        (f) =>
          !q ||
          f.label.toLowerCase().includes(q) ||
          (f.subtitle ?? '').toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q),
      );
      if (!items.length) continue;
      if (group.title && !q) {
        sectionRows.push({ kind: 'group', id: `${section.id}/${group.title}`, title: group.title });
      }
      for (const f of items) {
        sectionRows.push({
          kind: 'item',
          id: f.id,
          feature: f,
          sectionTitle: section.title,
        });
      }
    }
    if (sectionRows.length) {
      if (!q) rows.push({ kind: 'section', id: section.id, title: section.title });
      rows.push(...sectionRows);
    }
  }
  return rows;
}

function openFeature(feature: FeatureItem) {
  if (isExternal(feature.path)) {
    openURL(feature.path).catch(() => {});
    return;
  }
  // `/dashboard/models` → route `/feature/dashboard/models` (catch-all).
  router.push(`/feature${feature.path}`);
}

/**
 * More — the complete OmniRoute feature catalog (every section of the
 * dashboard navigation) plus app settings. This is the "all features" menu.
 */
export default function MoreScreen() {
  const [query, setQuery] = useState('');
  const { settings } = useSettings();
  const rows = useMemo(() => buildRows(query), [query]);

  const renderItem = ({ item }: { item: Row }) => {
    if (item.kind === 'section') {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{item.title}</Text>
        </View>
      );
    }
    if (item.kind === 'group') {
      return (
        <View style={styles.groupHeader}>
          <Text style={styles.groupTitle}>{item.title}</Text>
        </View>
      );
    }
    const f = item.feature;
    const external = isExternal(f.path);
    return (
      <Pressable
        style={({ pressed }) => [
          styles.item,
          pressed && { backgroundColor: theme.surfaceAlt },
        ]}
        onPress={() => openFeature(f)}
        accessibilityRole="button"
      >
        <View style={styles.itemIcon}>
          <MaterialCommunityIcons name={f.icon as never} size={19} color={theme.accent} />
        </View>
        <View style={styles.itemText}>
          <Text style={styles.itemLabel} numberOfLines={1}>
            {f.label}
          </Text>
          {f.subtitle ? (
            <Text style={styles.itemSubtitle} numberOfLines={1}>
              {f.subtitle}
            </Text>
          ) : null}
        </View>
        <MaterialCommunityIcons
          name={external ? 'open-in-new' : 'chevron-right'}
          size={18}
          color={theme.textMuted}
        />
      </Pressable>
    );
  };

  const keyExtractor = (row: Row) => row.id;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>All Features</Text>
        <Text style={styles.subtitle}>
          {TOTAL_FEATURE_COUNT} OmniRoute features · {settings.serverUrl || 'no gateway'}
        </Text>
        <View style={styles.searchRow}>
          <MaterialCommunityIcons name="magnify" size={18} color={theme.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search features…"
            placeholderTextColor={theme.textMuted}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query ? (
            <Pressable hitSlop={10} onPress={() => setQuery('')}>
              <MaterialCommunityIcons name="close-circle" size={18} color={theme.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 96 }}
        ListHeaderComponent={
          <Pressable
            style={({ pressed }) => [styles.settingsCard, pressed && { opacity: 0.85 }]}
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
          >
            <View style={[styles.itemIcon, { backgroundColor: theme.accentSoft }]}>
              <MaterialCommunityIcons name="cog" size={19} color={theme.accent} />
            </View>
            <View style={styles.itemText}>
              <Text style={styles.itemLabel}>Server Settings</Text>
              <Text style={styles.itemSubtitle} numberOfLines={1}>
                {settings.serverUrl || 'Not configured'} · data · about
              </Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={18} color={theme.textMuted} />
          </Pressable>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialCommunityIcons name="magnify-close" size={32} color={theme.textMuted} />
            <Text style={styles.emptyText}>No features match “{query}”</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    backgroundColor: theme.tabBarBg,
  },
  title: { color: theme.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginTop: 10,
    height: 40,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: 14, padding: 0 },
  sectionHeader: {
    marginHorizontal: 16,
    marginTop: 18,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  groupHeader: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 2,
  },
  groupTitle: { color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  itemIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: theme.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemText: { flex: 1 },
  itemLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  itemSubtitle: { color: theme.textMuted, fontSize: 11, marginTop: 1 },
  settingsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  empty: { alignItems: 'center', gap: 10, paddingTop: 60 },
  emptyText: { color: theme.textMuted, fontSize: 13 },
});
