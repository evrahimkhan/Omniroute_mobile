/**
 * The menu.
 *
 * This is the screen the WebView used to be: the way into everything the gateway
 * can do. Its first version after the rewrite was native but web-shaped — the
 * dashboard's whole sidebar taxonomy (OmniProxy, Analytics, Costs, Dev Tools,
 * "Other Features"…) poured into one scrolling list of ninety-four rows, which
 * is the web sidebar with a different scroll bar.
 *
 * A phone menu is short and it drills. So this screen offers: the gateway's
 * status, the six screens used daily, a search box, and nine named sections —
 * each one tap from its own list. Nothing here is a link to a browser view.
 */

import React, { useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Badge, Card, ListRow, Screen, SearchField } from '../../components/ui/kit';
import ScreenHeader from '../../components/ScreenHeader';
import { useApiContext, useSession } from '../../lib/api/context';
import { findSurface, searchSurfaces, SECTIONS, SURFACES } from '../../lib/screens/catalog';
import { openSurface, QUICK_SURFACE_IDS } from '../../lib/screens/navigation';
import { APP_LINKS } from '../../lib/destinations';
import { theme } from '../../lib/theme';

export default function MenuScreen() {
  const router = useRouter();
  const { api } = useApiContext();
  const session = useSession();
  const [query, setQuery] = useState('');

  const quick = useMemo(
    () => QUICK_SURFACE_IDS.map((id) => findSurface(id)).filter((surface): surface is NonNullable<typeof surface> => Boolean(surface)),
    []
  );

  // Searching covers every surface, flat — a phone search should not make you
  // guess which section a setting lives in.
  const results = useMemo(() => (query.trim() ? searchSurfaces(query) : []), [query]);
  const searching = query.trim().length > 0;

  return (
    <Screen padded={false}>
      <View style={styles.headerWrap}>
        <ScreenHeader title="Menu" subtitle={`${SURFACES.length} gateway functions, all native`} />
      </View>

      {searching ? (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.searchWrap}>
              <SearchField value={query} onChange={setQuery} placeholder="Search every function" />
              <Text style={styles.resultCount}>
                {results.length} result{results.length === 1 ? '' : 's'}
              </Text>
            </View>
          }
          ListEmptyComponent={<Text style={styles.empty}>Nothing matches “{query.trim()}”.</Text>}
          renderItem={({ item }) => (
            <View style={styles.rowWrap}>
              <ListRow
                title={item.title}
                subtitle={item.section}
                icon={item.icon}
                onPress={() => openSurface(router, item)}
              />
            </View>
          )}
        />
      ) : (
        <FlatList
          data={SECTIONS}
          keyExtractor={(item) => item.id}
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
                <SearchField value={query} onChange={setQuery} placeholder="Search every function" />
              </View>

              <Text style={styles.groupLabel}>EVERYDAY</Text>
              <View style={styles.quickCard}>
                {quick.map((surface, index) => (
                  <View key={surface.id} style={index > 0 ? styles.rowBorder : undefined}>
                    <ListRow
                      title={surface.title}
                      subtitle={surface.subtitle}
                      icon={surface.icon}
                      onPress={() => openSurface(router, surface)}
                    />
                  </View>
                ))}
              </View>

              <Text style={styles.groupLabel}>EVERYTHING ELSE</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.rowWrap}>
              <ListRow
                title={item.label}
                subtitle={item.subtitle}
                icon={item.icon}
                detail={String(item.surfaces.length)}
                onPress={() => router.push(`/section/${item.id}` as never)}
              />
            </View>
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <ListRow
                title="About the app"
                subtitle="Native screens, the gateway's API, and what each one does"
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
                The catalog is generated from the gateway’s own dashboard definition, so nothing the gateway can do is
                missing from this menu.
              </Text>
            </View>
          }
        />
      )}
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
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 18, textAlign: 'center' },
  groupLabel: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginTop: 24,
    marginBottom: 8,
  },
  quickCard: { backgroundColor: theme.surface, borderRadius: 12, overflow: 'hidden' },
  rowWrap: { backgroundColor: theme.surface, borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  footer: { marginTop: 24, gap: 6 },
  credits: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 14, paddingHorizontal: 2 },
});
