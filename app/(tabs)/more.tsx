/**
 * The catalog: every gateway surface, searchable.
 *
 * This used to be a list of 94 dashboard URLs that each opened a WebView. It is
 * now the app's index of its own screens: the grouped sections mirror the
 * dashboard's sidebar so anyone who knows the product can find a setting, and
 * search looks across titles, subtitles and API routes. Tapping an entry opens a
 * native screen — seven of them purpose-built, the rest drawn from the gateway's
 * API by the surface renderers.
 *
 * The counts are shown per section rather than hidden, because "how much of the
 * dashboard is in here" is a fair question to ask of a screen like this.
 */

import React, { useMemo, useState } from 'react';
import { Linking, SectionList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Badge, Card, ListRow, Screen, SearchField, uiStyles } from '../../components/ui/kit';
import ScreenHeader from '../../components/ScreenHeader';
import { useApiContext, useSession } from '../../lib/api/context';
import { searchSurfaces, SECTIONS, SURFACES, type Surface } from '../../lib/screens/catalog';
import { APP_LINKS } from '../../lib/destinations';
import { theme } from '../../lib/theme';

export default function MoreScreen() {
  const router = useRouter();
  const { api } = useApiContext();
  const session = useSession();
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const matches = new Set(searchSurfaces(query).map((surface) => surface.id));
    return SECTIONS.map((section) => ({
      title: section.title,
      data: section.surfaces.filter((surface) => matches.has(surface.id)),
    })).filter((section) => section.data.length > 0);
  }, [query]);

  const open = (surface: Surface) => {
    if (surface.kind === 'custom' && surface.route) router.push(surface.route as never);
    else router.push(`/surface/${surface.id}` as never);
  };

  const total = SURFACES.length;

  return (
    <Screen padded={false}>
      <View style={styles.headerWrap}>
        <ScreenHeader title="More" subtitle={`${total} gateway surfaces, all native`} />
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Card style={styles.connection}>
              <View style={styles.connectionRow}>
                <MaterialCommunityIcons
                  name={api ? 'server-network' : 'server-network-off'}
                  size={20}
                  color={api ? theme.success : theme.textMuted}
                />
                <View style={styles.connectionText}>
                  <Text style={styles.connectionTitle}>{api ? 'Connected' : 'No gateway configured'}</Text>
                  <Text style={styles.connectionSub} numberOfLines={1}>
                    {api?.base || 'Set an address in Settings'}
                  </Text>
                </View>
                {session.authenticated ? <Badge label="signed in" tone="ok" /> : null}
              </View>
              <View style={styles.connectionActions}>
                <Text style={styles.connectionLink} onPress={() => router.push('/settings')}>
                  Gateway settings
                </Text>
                {!session.authenticated ? (
                  <Text style={styles.connectionLink} onPress={() => router.push('/sign-in')}>
                    Sign in
                  </Text>
                ) : null}
              </View>
            </Card>

            <View style={styles.searchWrap}>
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={`Search ${total} surfaces`}
              />
            </View>

            {query.trim() ? (
              <Text style={styles.resultCount}>
                {sections.reduce((count, section) => count + section.data.length, 0)} matching surface
                {sections.reduce((count, section) => count + section.data.length, 0) === 1 ? '' : 's'}
              </Text>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <ListRow
              title={item.title}
              subtitle={item.subtitle || item.path || item.page}
              icon={item.icon}
              detail={item.kind === 'custom' ? 'app' : undefined}
              onPress={() => open(item)}
            />
          </View>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <ListRow
              title="About the app"
              subtitle="Native screens, the gateway's API, and what stays on the dashboard"
              icon="information-outline"
              onPress={() => Linking.openURL(APP_LINKS.docs).catch(() => undefined)}
            />
            <ListRow
              title="OmniRoute upstream"
              subtitle="The gateway this app talks to"
              icon="github"
              onPress={() => Linking.openURL(APP_LINKS.upstream).catch(() => undefined)}
            />
            <ListRow
              title="Build history"
              subtitle="App CI and APK runs"
              icon="history"
              onPress={() => Linking.openURL(APP_LINKS.builds).catch(() => undefined)}
            />
            <Text style={styles.credits}>
              Catalog generated from the gateway’s own dashboard definition. Surfaces with their own screen are marked
              “app”; the rest are drawn from the gateway’s API.
            </Text>
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: { paddingHorizontal: 16 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  connection: { marginTop: 4 },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  connectionText: { flex: 1 },
  connectionTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  connectionSub: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  connectionActions: { flexDirection: 'row', gap: 16, marginTop: 12 },
  connectionLink: { color: theme.accent, fontSize: 13, fontWeight: '600' },
  searchWrap: { marginTop: 14 },
  resultCount: { color: theme.textMuted, fontSize: 12, marginTop: 10 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 8,
  },
  sectionTitle: { color: theme.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase' },
  sectionCount: { color: theme.textMuted, fontSize: 11 },
  rowWrap: { backgroundColor: theme.surface, borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
  footer: { marginTop: 24, gap: 6 },
  credits: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 14, paddingHorizontal: 2 },
});

// Kept so the file's own styles and the kit's stay in one visual language.
void uiStyles;
