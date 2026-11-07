import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
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
import {
  createProvider,
  deleteProvider,
  getProviders,
  setProvidersActive,
  type Provider,
} from '../../lib/api/resources';
import { scalarFields } from '../../lib/api/shape';
import { theme } from '../../lib/theme';

import { UPSTREAM_PROVIDER_PRESETS } from '../../lib/api/upstreamProviders';

const PRESET_PROVIDERS = [
  ...UPSTREAM_PROVIDER_PRESETS,
  { id: 'custom', label: 'Custom…', name: '' },
];

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
  const insets = useSafeAreaInsets();
  const { api, waiting } = useApiContext();
  const { showToast } = useToast();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [selected, setSelected] = useState<Provider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newProvider, setNewProvider] = useState('openai');
  const [newName, setNewName] = useState('OpenAI');
  const [newApiKey, setNewApiKey] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [presetSearch, setPresetSearch] = useState('');

  const filteredPresets = useMemo(() => {
    const q = presetSearch.trim().toLowerCase();
    if (!q) return PRESET_PROVIDERS;
    return PRESET_PROVIDERS.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q)
    );
  }, [presetSearch]);

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

  const selectPreset = (preset: (typeof PRESET_PROVIDERS)[number]) => {
    if (preset.id === 'custom') {
      setNewProvider('');
      setNewName('');
    } else {
      setNewProvider(preset.id);
      setNewName(preset.name);
    }
  };

  const submitCreate = async () => {
    if (!api) return;
    const providerSlug = newProvider.trim().toLowerCase();
    const displayName = newName.trim() || providerSlug;
    const key = newApiKey.trim();
    if (!providerSlug) {
      setCreateError('Provider ID is required');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      await createProvider(api, {
        provider: providerSlug,
        name: displayName,
        apiKey: key || undefined,
      });
      showToast(`Added ${displayName}`, 'ok');
      setCreating(false);
      setNewProvider('openai');
      setNewName('OpenAI');
      setNewApiKey('');
      await providers.reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const remove = async (provider: Provider) => {
    if (!api) return;
    const ok = await confirm({
      title: `Delete ${provider.name}?`,
      message: 'This connection will be removed from the gateway and routing.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(provider.id);
    try {
      await deleteProvider(api, provider.id);
      showToast(`${provider.name} deleted`, 'ok');
      setSelected(null);
      await providers.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

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
      <View style={[styles.toolbar, { paddingTop: Math.max(insets.top, 12) }]}>
        <View style={styles.searchRow}>
          <View style={styles.searchFieldWrap}>
            <SearchField value={query} onChange={setQuery} placeholder="Search providers" />
          </View>
          <Button label="Add" icon="plus" onPress={() => setCreating(true)} style={styles.addBtn} />
        </View>
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
                    : 'Add a provider connection (OpenAI, Anthropic, OpenRouter, etc.) to start routing requests.'
                }
                action={<Button label="Add provider" icon="plus" onPress={() => setCreating(true)} />}
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
        visible={creating}
        onClose={() => setCreating(false)}
        title="Add provider connection"
        subtitle="Connect an AI service to route model requests."
        fullHeight
        footer={
          <Button
            label="Save connection"
            icon="check"
            loading={createBusy}
            onPress={submitCreate}
          />
        }
      >
        <SectionHeader title="SEARCH 380+ PRESETS" />
        <View style={{ marginBottom: 12 }}>
          <SearchField
            value={presetSearch}
            onChange={setPresetSearch}
            placeholder="Search provider presets (e.g. deepseek, groq, together)..."
          />
        </View>
        <Text style={styles.countText}>
          {filteredPresets.length > 50 ? `Showing 50 of ${filteredPresets.length} matching presets` : `${filteredPresets.length} presets`}
        </Text>
        <View style={{ gap: 6, marginBottom: 16, marginTop: 6 }}>
          {filteredPresets.slice(0, 50).map((p) => {
            const isCustom = p.id === 'custom';
            const isSelected = isCustom
              ? !PRESET_PROVIDERS.some((item) => item.id !== 'custom' && item.id === newProvider)
              : newProvider === p.id;
            return (
              <ListRow
                key={p.id}
                icon={isCustom ? 'pencil-outline' : 'lan-connect'}
                iconColor={isSelected ? theme.accent : theme.textMuted}
                title={p.label}
                subtitle={p.id}
                right={
                  isSelected ? (
                    <Badge label="Selected" tone="accent" />
                  ) : undefined
                }
                onPress={() => selectPreset(p)}
              />
            );
          })}
        </View>

        <Field
          label="Provider ID"
          value={newProvider}
          onChange={(v) => {
            setNewProvider(v);
            if (!newName || PRESET_PROVIDERS.some((item) => item.name === newName)) {
              setNewName(v.charAt(0).toUpperCase() + v.slice(1));
            }
          }}
          placeholder="e.g. openai, anthropic, openrouter"
          hint="ID recognized by OmniRoute (over 350 providers supported)."
        />

        <Field
          label="Connection name"
          value={newName}
          onChange={setNewName}
          placeholder="e.g. My OpenAI"
          hint="A label to identify this connection."
        />

        <Field
          label="API Key"
          value={newApiKey}
          onChange={setNewApiKey}
          placeholder="sk-..."
          secure
          hint="Stored securely on this gateway. Never shared."
        />

        {createError ? <Text style={styles.errorText}>{createError}</Text> : null}
      </Sheet>

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        subtitle={selected ? `${selected.provider} · ${selected.id}` : undefined}
        footer={
          selected ? (
            <View style={styles.sheetFooter}>
              <ToggleRow
                title={selected.active ? 'Enabled' : 'Disabled'}
                subtitle="A disabled connection is skipped by routing, without losing its credentials."
                value={selected.active ?? false}
                disabled={busyId === selected.id}
                onChange={(next) => toggle(selected, next)}
              />
              <Button
                label="Delete connection"
                variant="danger"
                icon="delete-outline"
                loading={busyId === selected.id}
                onPress={() => remove(selected)}
              />
            </View>
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
  searchRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  searchFieldWrap: { flex: 1 },
  addBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  chips: { flexDirection: 'row', gap: 8 },
  list: { padding: 14, paddingBottom: 96 },
  switchBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  sheetFooter: { gap: 12 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  countText: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  errorText: { color: theme.danger, fontSize: 13, marginTop: 8 },
});
