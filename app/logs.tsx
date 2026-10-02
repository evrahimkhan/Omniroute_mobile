import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import ScreenHeader from '../components/ScreenHeader';
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
} from '../components/ui/kit';
import { Sheet } from '../components/ui/Sheet';
import { useApiContext, usePolling } from '../lib/api/context';
import { getCallLogs, logSummary, type CallLog } from '../lib/api/resources';
import { scalarFields } from '../lib/api/shape';
import { theme } from '../lib/theme';

/**
 * Request log — the gateway's own view of what it did, natively.
 *
 * This is the screen that most obviously belongs on a phone: "did my request go
 * through, and what did it cost" is a question asked while away from a desk. The
 * filters are the ones the API actually supports (`status`, `search`, `model`,
 * `provider` — see `/api/usage/call-logs` upstream), so each chip is a real
 * server-side narrow rather than a client-side slice of the first page.
 */
export default function LogsScreen() {
  const { api, waiting } = useApiContext();
  const [query, setQuery] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [selected, setSelected] = useState<CallLog | null>(null);

  const logs = usePolling(
    api ? () => getCallLogs(api, { limit: 50, search: query.trim() || undefined, status: onlyErrors ? 'error' : undefined }) : null,
    15_000,
    [query, onlyErrors]
  );

  const errorCount = useMemo(() => (logs.data ?? []).filter((log) => !log.ok).length, [logs.data]);

  if (waiting) return <Loading label="Reading settings…" />;

  return (
    <View style={uiStyles.screen}>
      <ScreenHeader
        title="Request log"
        subtitle={`${logs.data?.length ?? 0} of the most recent${errorCount ? ` · ${errorCount} failed` : ''}`}
      />

      <View style={styles.toolbar}>
        <SearchField value={query} onChange={setQuery} placeholder="Search model, key or request id" />
        <View style={styles.chips}>
          <Chip label="All" icon="format-list-bulleted" selected={!onlyErrors} onPress={() => setOnlyErrors(false)} />
          <Chip label="Errors only" icon="alert-circle-outline" selected={onlyErrors} onPress={() => setOnlyErrors(true)} />
        </View>
      </View>

      {!api ? (
        <EmptyState icon="link-off" title="No gateway configured" body="Set the gateway address in Settings first." />
      ) : logs.error && !logs.data ? (
        <ErrorState message={logs.error} onRetry={logs.reload} />
      ) : (
        <FlatList
          data={logs.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={logs.loading} onRefresh={logs.reload} tintColor={theme.textMuted} />
          }
          ListHeaderComponent={
            logs.data?.length ? (
              <Text style={styles.hint}>Pull down to refresh · updates every 15s while open</Text>
            ) : null
          }
          ListEmptyComponent={
            logs.loading ? (
              <Loading label="Reading the log…" />
            ) : (
              <EmptyState
                icon="text-box-search-outline"
                title={query || onlyErrors ? 'Nothing matches' : 'No requests yet'}
                body={
                  query || onlyErrors
                    ? 'Try a different search, or clear the filter.'
                    : 'Requests you make through the gateway appear here within a few seconds.'
                }
              />
            )
          }
          renderItem={({ item }) => (
            <ListRow
              icon={item.ok ? 'check-circle-outline' : 'alert-circle-outline'}
              iconColor={item.ok ? theme.success : theme.danger}
              title={item.model}
              subtitle={[item.provider, logSummary(item)].filter(Boolean).join(' · ')}
              detail={item.when}
              right={
                <MaterialCommunityIcons
                  name={item.ok ? 'arrow-right' : 'alert'}
                  size={16}
                  color={item.ok ? theme.textMuted : theme.danger}
                />
              }
              onPress={() => setSelected(item)}
            />
          )}
        />
      )}

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.model ?? ''}
        subtitle={selected ? `${selected.provider} · ${selected.when}` : undefined}
      >
        {selected ? (
          <>
            <View style={styles.sheetRow}>
              <Badge label={selected.status} tone={selected.ok ? 'ok' : 'danger'} />
              {selected.latencyMs !== undefined ? <Badge label={`${Math.round(selected.latencyMs)} ms`} /> : null}
              {selected.tokens !== undefined ? <Badge label={`${selected.tokens} tokens`} tone="accent" /> : null}
              {selected.cost !== undefined ? <Badge label={`$${selected.cost.toFixed(4)}`} tone="warn" /> : null}
            </View>
            <SectionHeader title="AS THE GATEWAY REPORTS IT" />
            <Card>
              {scalarFields(selected.raw, 40).map((field) => (
                <KeyValue key={field.key} label={field.key} value={field.value} />
              ))}
            </Card>
            <Text style={styles.note}>
              Fields appear as the gateway names them; the app shows what it received rather than a guessed
              summary.
            </Text>
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 14, paddingTop: 12, gap: 10 },
  chips: { flexDirection: 'row', gap: 8 },
  list: { padding: 14, paddingTop: 6, paddingBottom: 64 },
  hint: { color: theme.textMuted, fontSize: 11, marginBottom: 6, marginLeft: 4 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  note: { color: theme.textMuted, fontSize: 11, lineHeight: 16, paddingHorizontal: 4 },
});
