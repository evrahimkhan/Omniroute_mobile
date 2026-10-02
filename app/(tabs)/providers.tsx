import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

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
  ToggleRow,
  uiStyles,
} from '../../components/ui/kit';
import { Sheet, confirm } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { useApiContext, usePolling } from '../../lib/api/context';
import { getProviders, setProvidersActive, type Provider } from '../../lib/api/resources';
import { scalarFields } from '../../lib/api/shape';
import { theme } from '../../lib/theme';

/**
 * Providers — the connection list, natively.
 *
 * The dashboard's provider page is one of the heaviest in the product (a grid of
 * cards, filters, bulk actions). What a phone needs from it is smaller and
 * sharper: which connections exist, which are on, and a switch to change that —
 * plus the detail a card would have shown, in a sheet.
 *
 * The switch is the one write this screen performs. It goes through the same
 * endpoint the dashboard uses (`PATCH /api/providers {ids, isActive}`), so both
 * see the same state, and the list is re-read after a change rather than being
 * optimistically edited: a provider the gateway refuses to enable (a retired
 * ChatGPT-web connection, say) must not look enabled in the app.
 */
export default function ProvidersScreen() {
  const { api, waiting } = useApiContext();
  const { showToast } = useToast();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [selected, setSelected] = useState<Provider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const providers = usePolling(api ? () => getProviders(api) : null, 30_000);

  const rows = useMemo(() => {
    const list = providers.data ?? [];
    const needle = query.trim().toLowerCase();
    return list
      .filter((p) => (filter === 'all' ? true : filter === 'on' ? p.active === true : p.active === false))
      .filter((p) =>
        needle
          ? p.name.toLowerCase().includes(needle) ||
            p.provider.toLowerCase().includes(needle) ||
            (p.detail ?? '').toLowerCase().includes(needle)
          : true
      );
  }, [providers.data, query, filter]);

  const toggle = async (provider: Provider, next: boolean) => {
    if (!api) return;
    setBusyId(provider.id);
    try {
      const result = await setProvidersActive(api, [provider.id], next);
      if (result.notFound.length) {
        showToast(`The gateway does not know connection ${provider.id}`, 'danger');
      } else {
        showToast(`${provider.name} ${next ? 'enabled' : 'disabled'}`, 'ok');
      }
      await providers.reload();
      setSelected((current) => (current && current.id === provider.id ? { ...current, active: next } : current));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  if (waiting) return <Loading label="Reading settings…" />;
  if (!api) {
    return (
      <View style={uiStyles.screen}>
        <EmptyState icon="link-off" title="No gateway configured" body="Open Settings to point the app at a gateway." />
      </View>
    );
  }

  const activeCount = (providers.data ?? []).filter((p) => p.active).length;

  return (
    <View style={uiStyles.screen}>
      <View style={styles.toolbar}>
        <SearchField value={query} onChange={setQuery} placeholder="Search providers" />
        <View style={styles.chips}>
          {(['all', 'on', 'off'] as const).map((value) => (
            <Chip
              key={value}
              label={value === 'all' ? `All ${providers.data?.length ?? ''}` : value === 'on' ? `On ${activeCount}` : 'Off'}
              selected={filter === value}
              onPress={() => setFilter(value)}
            />
          ))}
        </View>
      </View>

      {providers.error && !providers.data ? (
        <ErrorState message={providers.error} onRetry={providers.reload} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={providers.loading} onRefresh={providers.reload} tintColor={theme.textMuted} />
          }
          ListEmptyComponent={
            providers.loading ? (
              <Loading label="Reading connections…" />
            ) : (
              <EmptyState
                icon="lan-disconnect"
                title={query ? 'Nothing matches' : 'No provider connections'}
                body={
                  query
                    ? 'Try a different name.'
                    : 'Add a provider in the dashboard once — the app shows it here afterwards.'
                }
              />
            )
          }
          renderItem={({ item }) => (
            <ListRow
              icon={item.active ? 'lan-connect' : 'lan-disconnect'}
              iconColor={item.active ? theme.success : theme.textMuted}
              title={item.name}
              subtitle={[item.provider, item.detail].filter(Boolean).join(' · ')}
              right={
                <Button
                  label={item.active ? 'On' : 'Off'}
                  variant={item.active ? 'primary' : 'secondary'}
                  loading={busyId === item.id}
                  onPress={() => toggle(item, !(item.active ?? false))}
                  style={styles.switchBtn}
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
        title={selected?.name ?? ''}
        subtitle={selected ? `${selected.provider} · ${selected.id}` : undefined}
        footer={
          selected ? (
            <ToggleRow
              title={selected.active ? 'Enabled' : 'Disabled'}
              subtitle="A disabled connection is skipped by routing, without losing its credentials."
              value={selected.active ?? false}
              disabled={busyId === selected.id}
              onChange={(next) => toggle(selected, next)}
            />
          ) : undefined
        }
      >
        {selected ? (
          <>
            <View style={styles.sheetRow}>
              {selected.active !== undefined ? (
                <Badge label={selected.active ? 'active' : 'inactive'} tone={selected.active ? 'ok' : 'muted'} />
              ) : (
                <Badge label="state not reported" tone="warn" />
              )}
              {selected.models !== undefined ? (
                <Badge label={`${selected.models} models`} tone="accent" />
              ) : null}
            </View>
            <SectionHeader title="AS THE GATEWAY REPORTS IT" />
            <Card>
              {scalarFields(selected.raw).map((field) => (
                <KeyValue key={field.key} label={field.key} value={field.value} />
              ))}
            </Card>
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 14, paddingTop: 12, gap: 10 },
  chips: { flexDirection: 'row', gap: 8 },
  list: { padding: 14, paddingBottom: 96 },
  switchBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
