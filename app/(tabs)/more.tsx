import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { openURL } from 'expo-linking';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ListRow,
  Screen,
  SearchField,
  SectionHeader,
} from '../../components/ui/kit';
import { useApiContext } from '../../lib/api/context';
import { APP_LINKS, NATIVE_DESTINATIONS, type Destination } from '../../lib/destinations';
import { hostOf } from '../../lib/gateway';
import { useSettings } from '../../lib/useSettings';
import { theme } from '../../lib/theme';

/**
 * More — the native menu.
 *
 * This replaces the "More" tab that listed 94 dashboard features and opened each
 * one in a WebView. The honest version of that list on a native app is shorter:
 * what the app can actually do, grouped by what it is for, with a search box so
 * a destination is two taps away at most.
 *
 * Features that exist only as dashboard pages are not listed as if they worked.
 * See docs/NATIVE_UI.md for the migration table — including which surfaces are
 * planned next and why the rest stay on the dashboard.
 */
export default function MoreScreen() {
  const { api, session } = useApiContext();
  const { settings } = useSettings();
  const [query, setQuery] = useState('');

  const destinations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return NATIVE_DESTINATIONS;
    return NATIVE_DESTINATIONS.map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) || (item.subtitle ?? '').toLowerCase().includes(needle)
      ),
    })).filter((section) => section.items.length);
  }, [query]);

  const count = NATIVE_DESTINATIONS.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <Screen scroll>
      <View style={styles.hero}>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>{hostOf(settings.serverUrl) || 'No gateway'}</Text>
          <Text style={styles.heroSubtitle}>
            {api
              ? session.authenticated === false
                ? 'Gateway wants a session — sign in from Settings'
                : 'Connected'
              : 'Settings still loading'}
          </Text>
        </View>
        {session.authenticated === false ? (
          <Button label="Sign in" icon="login" onPress={() => router.push('/sign-in')} style={styles.heroBtn} />
        ) : (
          <Badge label={api ? 'native' : 'idle'} tone={api ? 'ok' : 'muted'} icon="cellphone" />
        )}
      </View>

      <View style={styles.searchWrap}>
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${count} destinations`} />
      </View>

      {destinations.length ? (
        destinations.map((section) => (
          <View key={section.id}>
            <SectionHeader title={section.title} />
            <Card>
              {section.items.map((item: Destination) => (
                <ListRow
                  key={item.id}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                  onPress={() => router.push(item.route as never)}
                />
              ))}
            </Card>
          </View>
        ))
      ) : (
        <EmptyState
          icon="magnify-close"
          title="Nothing matches"
          body="Try “keys”, “providers”, “log” or “gateway”."
        />
      )}

      <SectionHeader title="ABOUT" />
      <Card>
        <ListRow
          icon="book-open-variant"
          title="How the app works"
          subtitle="Native screens, the gateway's API, and what stays on the dashboard"
          onPress={() => openURL(APP_LINKS.docs).catch(() => {})}
        />
        <ListRow
          icon="github"
          title="OmniRoute source"
          subtitle="github.com/diegosouzapw/OmniRoute"
          onPress={() => openURL(APP_LINKS.upstream).catch(() => {})}
        />
        <ListRow
          icon="hammer-wrench"
          title="Builds"
          subtitle="Actions, APKs and the gateway payload"
          onPress={() => openURL(APP_LINKS.builds).catch(() => {})}
        />
      </Card>

      <Text style={styles.footnote}>
        <MaterialCommunityIcons name="cellphone" size={11} color={theme.textMuted} /> Every screen in this app is
        native. Nothing is rendered in a browser view.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    marginBottom: 12,
  },
  heroText: { flex: 1, gap: 2 },
  heroTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  heroSubtitle: { color: theme.textMuted, fontSize: 12 },
  heroBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  searchWrap: { marginBottom: 4 },
  footnote: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 14, paddingHorizontal: 4 },
});
