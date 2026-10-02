import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  KeyValue,
  ListRow,
  Loading,
  SearchField,
  SectionHeader,
  uiStyles,
} from '../../components/ui/kit';
import { Sheet } from '../../components/ui/Sheet';
import { useApiContext, usePolling } from '../../lib/api/context';
import { getModels, type ModelEntry } from '../../lib/api/resources';
import { compactNumber, scalarFields, titleCase } from '../../lib/api/shape';
import { theme } from '../../lib/theme';

/**
 * Models — the catalog, natively.
 *
 * The gateway's catalog is large (thousands of entries across ~358 providers), so
 * this screen is built around narrowing rather than browsing: a search box, a
 * provider filter, and rows that say whether the model is actually callable
 * ("configured") right now. That last flag is the whole reason to look at this
 * screen on a phone — the catalog itself is a reference, but "which of these can
 * I use" is a question.
 */
export default function ModelsScreen() {
  const { api, waiting } = useApiContext();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModelEntry | null>(null);

  const models = usePolling(api ? () => getModels(api, { all: true }) : null, 0);

  const catalogue = models.data ?? [];

  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of catalogue) {
      if (!model.provider) continue;
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalogue]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogue
      .filter((model) => (provider ? model.provider === provider : true))
      .filter((model) =>
        needle ? model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle) : true
      )
      .sort((a, b) => Number(b.configured ?? false) - Number(a.configured ?? false) || a.id.localeCompare(b.id));
  }, [catalogue, provider, query]);

  const configured = catalogue.filter((m) => m.configured).length;

  if (waiting) return <Loading label="Reading settings…" />;
  if (!api) {
    return (
      <View style={uiStyles.screen}>
        <EmptyState icon="link-off" title="No gateway configured" body="Open Settings to point the app at a gateway." />
      </View>
    );
  }

  return (
    <View style={uiStyles.screen}>
      <View style={styles.toolbar}>
        <SearchField value={query} onChange={setQuery} placeholder="Search models" />
        <FlatList
          horizontal
          data={providers.slice(0, 40)}
          keyExtractor={(item) => item[0]}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          ListHeaderComponent={
            <Chip label={`All ${catalogue.length}`} selected={provider === null} onPress={() => setProvider(null)} />
          }
          renderItem={({ item }) => (
            <Chip
              label={`${titleCase(item[0])} ${item[1]}`}
              selected={provider === item[0]}
              onPress={() => setProvider(provider === item[0] ? null : item[0])}
            />
          )}
        />
        <Text style={styles.count}>
          {rows.length} shown{models.data ? ` · ${configured} callable now` : ''}
        </Text>
      </View>

      {models.error && !models.data ? (
        <ErrorState message={models.error} onRetry={models.reload} />
      ) : (
        <FlatList
          data={rows.slice(0, 600)}
          keyExtractor={(item) => item.id}
          initialNumToRender={16}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={models.loading} onRefresh={models.reload} tintColor={theme.textMuted} />
          }
          ListEmptyComponent={
            models.loading ? (
              <Loading label="Reading the catalog…" />
            ) : (
              <EmptyState
                icon="magnify-close"
                title={query ? 'No model matches' : 'The catalog is empty'}
                body={query ? 'Try part of a model name, or clear the provider filter.' : undefined}
              />
            )
          }
          renderItem={({ item }) => (
            <ListRow
              icon={item.configured ? 'check-circle-outline' : 'circle-outline'}
              iconColor={item.configured ? theme.success : theme.textMuted}
              title={item.name}
              subtitle={item.id}
              detail={item.contextLength ? `${compactNumber(item.contextLength)} ctx` : undefined}
              onPress={() => setSelected(item)}
            />
          )}
        />
      )}

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        subtitle={selected?.id}
        footer={
          selected ? (
            <View style={styles.sheetActions}>
              <Button
                label="Use in Playground"
                icon="chat-processing-outline"
                onPress={() => {
                  const model = selected.id;
                  setSelected(null);
                  router.push({ pathname: '/(tabs)/chat', params: { model } });
                }}
              />
            </View>
          ) : undefined
        }
      >
        {selected ? (
          <>
            <View style={styles.sheetRow}>
              <Badge
                label={selected.configured ? 'callable now' : 'provider not connected'}
                tone={selected.configured ? 'ok' : 'muted'}
              />
              {selected.provider ? <Badge label={selected.provider} tone="accent" /> : null}
            </View>
            <SectionHeader title="AS THE GATEWAY REPORTS IT" />
            <Card>
              {scalarFields(selected.raw).map((field) => (
                <KeyValue key={field.key} label={field.key} value={field.value} />
              ))}
              {scalarFields(selected.raw).length === 0 ? (
                <KeyValue label="fields" value="The catalog listed this model by name only." />
              ) : null}
            </Card>
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 14, paddingTop: 12, gap: 10 },
  chips: { gap: 8, paddingVertical: 2 },
  count: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  list: { padding: 14, paddingTop: 6, paddingBottom: 96 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  sheetActions: { flexDirection: 'row', gap: 8 },
});
