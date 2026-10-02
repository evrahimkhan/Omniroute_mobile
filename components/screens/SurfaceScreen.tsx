/**
 * One native screen for every gateway function.
 *
 * The dashboard has 94 sidebar surfaces. Seven of them have a purpose-built
 * screen in this app; the rest are drawn by one of three renderers, chosen by
 * what the surface *is* — a settings object, a list of records, or numbers.
 * That is what replaces the WebView: not 94 screens written by hand, but three
 * renderers over the gateway's own API plus a catalog that says which is which.
 *
 * Nothing here opens a web page. A surface that is genuinely not gateway data
 * says so in a sentence; a link leaves the app only when the user taps it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Button, Card, ErrorState, Loading, Screen, SearchField } from '../ui/kit';
import ScreenHeader from '../ScreenHeader';
import { useApiContext, useResource } from '../../lib/api/context';
import { normalizeCollection } from '../../lib/api/collection';
import { configGroups } from '../../lib/api/config';
import { asArray, asRecord } from '../../lib/api/shape';
import { findSurface, type Surface } from '../../lib/screens/catalog';
import { theme } from '../../lib/theme';
import { CollectionBody } from './CollectionBody';
import { ConfigBody } from './ConfigBody';
import { StatsBody } from './StatsBody';
import { Note } from './chrome';

export function SurfaceScreen({ id }: { id: string }) {
  const surface = findSurface(id);

  if (!surface) {
    return (
      <Screen padded={false}>
        <View style={styles.headerWrap}>
          <ScreenHeader title="Not found" subtitle="This surface is not in the catalog" />
        </View>
        <Card style={styles.pad}>
          <Note>
            The app’s catalog is generated from the gateway’s dashboard, so a missing entry means the app is older than
            the gateway. Update the app, or pick the surface from the list.
          </Note>
        </Card>
      </Screen>
    );
  }

  return <SurfaceView surface={surface} />;
}

function SurfaceView({ surface }: { surface: Surface }) {
  const router = useRouter();
  const { api, waiting } = useApiContext();
  const [query, setQuery] = useState('');
  const isCustom = surface.kind === 'custom';
  const isStatic = surface.kind === 'external' || surface.kind === 'local';

  const run = useMemo(
    () => (api && surface.path && !isCustom && !isStatic ? async () => api.get<unknown>(surface.path as string) : null),
    [api, isCustom, isStatic, surface.path]
  );
  const resource = useResource(run, [surface.id]);
  const reload = useCallback(async () => {
    await resource.reload();
  }, [resource]);

  if (isCustom && surface.route) return <Redirect href={surface.route as never} />;

  if (surface.kind === 'external') {
    const url = surface.page?.startsWith('http') ? surface.page : 'https://github.com/diegosouzapw/OmniRoute';
    return (
      <Screen scroll>
        <ScreenHeader title={surface.title} subtitle={surface.subtitle} />
        <Card>
          <Note>{surface.note ?? 'This one is not part of the gateway — it leaves the app and opens in your browser.'}</Note>
          <View style={styles.actions}>
            <Button label="Open in browser" icon="open-in-new" onPress={() => Linking.openURL(url).catch(() => undefined)} />
          </View>
        </Card>
      </Screen>
    );
  }

  if (surface.kind === 'local') {
    return (
      <Screen scroll>
        <ScreenHeader title={surface.title} subtitle={surface.subtitle} />
        <Card>
          <Note>{surface.note ?? 'This surface configures the browser dashboard rather than the gateway.'}</Note>
        </Card>
        {surface.page ? (
          <View style={styles.replaces}>
            <Text style={styles.replacesText}>Replaces {surface.page}</Text>
          </View>
        ) : null}
      </Screen>
    );
  }

  if (waiting) return <Loading label="Reading settings…" />;

  if (!api) {
    return (
      <Screen>
        <ScreenHeader title={surface.title} subtitle={surface.subtitle} />
        <ErrorState
          message="No gateway is configured yet. Open Settings to point the app at one, or host a gateway on this phone."
          onRetry={() => router.push('/settings')}
        />
      </Screen>
    );
  }

  if (resource.error && resource.data === null) {
    return (
      <Screen>
        <ScreenHeader title={surface.title} subtitle={surface.subtitle} />
        <ErrorState message={resource.error} onRetry={reload} />
      </Screen>
    );
  }

  if (resource.data === null) return <Loading label={`Loading ${surface.title.toLowerCase()}…`} />;

  const payload = resource.data;
  const groups = surface.kind === 'config' ? configGroups(payload) : [];
  const collection = normalizeCollection(payload);
  const record = asRecord(payload);
  const isArrayPayload = Array.isArray(payload) || asArray(payload).length > 0;
  const hasRows = collection.rows.length > 0;

  // The payload decides the renderer when it disagrees with the catalog: a
  // settings route that answers with a list is drawn as a list, and a list route
  // that answers with numbers is drawn as numbers. Guessing wrong here would be a
  // blank screen, so the fallbacks are ordered rather than silent.
  let body: React.ReactNode;
  if (surface.kind === 'config' && groups.length > 0) {
    body = (
      <ConfigBody
        path={surface.path as string}
        method={surface.method ?? 'patch'}
        payload={payload}
        reload={reload}
      />
    );
  } else if (hasRows || isArrayPayload) {
    body = (
      <CollectionBody
        collection={collection}
        query={query}
        onQuery={setQuery}
        refreshing={resource.loading}
        onRefresh={reload}
      />
    );
  } else if (record) {
    body = <StatsBody payload={payload} />;
  } else {
    body = (
      <Card>
        <Note>This route answered with an empty response.</Note>
      </Card>
    );
  }

  const showSearch = (hasRows || isArrayPayload) && collection.rows.length > 4;

  return (
    <Screen padded={false}>
      <View style={styles.headerWrap}>
        <ScreenHeader title={surface.title} subtitle={surface.subtitle} />
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={resource.loading} onRefresh={reload} tintColor={theme.textMuted} />}
        keyboardShouldPersistTaps="handled"
      >
        {showSearch ? (
          <View style={styles.searchWrap}>
            <SearchField value={query} onChange={setQuery} placeholder="Filter these records" />
          </View>
        ) : null}
        {body}
        <View style={styles.footer}>
          <MaterialCommunityIcons name="server-network" size={14} color={theme.textMuted} />
          <Text style={styles.footerText} numberOfLines={1}>
            {surface.path ?? surface.page ?? surface.id}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: { paddingHorizontal: 16 },
  pad: { marginHorizontal: 16 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  searchWrap: { marginTop: 4, marginBottom: 4 },
  actions: { marginTop: 12 },
  replaces: { marginTop: 12, paddingHorizontal: 2 },
  replacesText: { color: theme.textMuted, fontSize: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 24, paddingHorizontal: 2 },
  footerText: { color: theme.textMuted, fontSize: 11, flexShrink: 1 },
});
