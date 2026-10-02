/**
 * One section of the menu: the surfaces that belong to it, and nothing else.
 *
 * The drill-down is the whole point of the menu's shape. A section holds between
 * three and thirty-six entries, which is a screenful a phone can show without
 * turning into the web sidebar.
 */

import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Card, ListRow, Screen } from '../../components/ui/kit';
import ScreenHeader from '../../components/ScreenHeader';
import { SECTIONS } from '../../lib/screens/catalog';
import { openSurface } from '../../lib/screens/navigation';
import { theme } from '../../lib/theme';
import { Note } from '../../components/screens/chrome';

export default function SectionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const section = SECTIONS.find((entry) => entry.id === id);

  if (!section) {
    return (
      <Screen padded={false}>
        <View style={styles.headerWrap}>
          <ScreenHeader title="Not found" subtitle="No such section" />
        </View>
        <Card style={styles.pad}>
          <Note>That section is not in this build’s catalog. Open the menu and pick one from the list.</Note>
        </Card>
      </Screen>
    );
  }

  const bespoke = section.surfaces.filter((surface) => surface.kind === 'custom').length;

  return (
    <Screen padded={false}>
      <View style={styles.headerWrap}>
        <ScreenHeader
          title={section.label}
          subtitle={`${section.surfaces.length} ${section.surfaces.length === 1 ? 'function' : 'functions'}${
            bespoke ? ` · ${bespoke} with their own screen` : ''
          }`}
        />
      </View>
      <FlatList
        data={section.surfaces}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<Text style={styles.sectionNote}>{section.subtitle}</Text>}
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <ListRow
              title={item.title}
              subtitle={item.subtitle || item.path}
              icon={item.icon}
              detail={item.kind === 'custom' ? 'app' : undefined}
              onPress={() => openSurface(router, item)}
            />
          </View>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <MaterialCommunityIcons name="information-outline" size={14} color={theme.textMuted} />
            <Text style={styles.footerText}>
              From the dashboard’s “{section.title}” section.
            </Text>
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: { paddingHorizontal: 16 },
  pad: { marginHorizontal: 16 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  sectionNote: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  rowWrap: { backgroundColor: theme.surface, borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 22, paddingHorizontal: 2 },
  footerText: { color: theme.textMuted, fontSize: 11 },
});
