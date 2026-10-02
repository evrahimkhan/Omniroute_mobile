import React, { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import ScreenHeader from '../components/ScreenHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  ListRow,
  Loading,
  SectionHeader,
  uiStyles,
} from '../components/ui/kit';
import { Sheet, confirm } from '../components/ui/Sheet';
import { useToast } from '../components/ui/Toast';
import { useApiContext, usePolling } from '../lib/api/context';
import { createKey, deleteKey, getKeys, type ApiKey } from '../lib/api/resources';
import { relativeTime, scalarFields } from '../lib/api/shape';
import { theme } from '../lib/theme';

/**
 * API keys — the "Endpoints" surface, natively.
 *
 * Two writes the dashboard does with a page each are here as a sheet and a
 * confirmation: create (name it, get the secret once, copy it) and revoke. The
 * secret is shown exactly once, from the create response, because the gateway
 * only returns it then — which is also why the create sheet keeps it on screen
 * with a copy button rather than dismissing into a toast.
 */
export default function KeysScreen() {
  const { api, waiting } = useApiContext();
  const { showToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [created, setCreated] = useState<ApiKey | null>(null);
  const [selected, setSelected] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const keys = usePolling(api ? async () => (await getKeys(api, { limit: 100 })).keys : null, 30_000);

  const copy = async (value: string, label = 'Copied') => {
    await Clipboard.setStringAsync(value);
    showToast(label, 'ok');
  };

  const submit = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const key = await createKey(api, { name: newName.trim() || 'Mobile key' });
      setCreating(false);
      setNewName('');
      if (key?.secret) {
        setCreated(key);
      } else {
        showToast('Key created — the gateway did not return its secret', 'default');
      }
      await keys.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!api) return;
    const ok = await confirm({
      title: 'Revoke this key?',
      message: `${key.name} stops working immediately. Anything using it will get a 401.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteKey(api, key.id);
      showToast(`${key.name} revoked`, 'ok');
      setSelected(null);
      await keys.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    }
  };

  if (waiting) return <Loading label="Reading settings…" />;

  return (
    <View style={uiStyles.screen}>
      <ScreenHeader
        title="API keys"
        subtitle="What your clients authenticate with"
        right={
          <Button label="New" icon="plus" onPress={() => setCreating(true)} style={styles.newBtn} />
        }
      />

      {!api ? (
        <EmptyState icon="link-off" title="No gateway configured" body="Set the gateway address in Settings first." />
      ) : keys.error && !keys.data ? (
        <ErrorState message={keys.error} onRetry={keys.reload} />
      ) : (
        <FlatList
          data={keys.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={keys.loading} onRefresh={keys.reload} tintColor={theme.textMuted} />
          }
          ListEmptyComponent={
            keys.loading ? (
              <Loading label="Reading keys…" />
            ) : (
              <EmptyState
                icon="key-outline"
                title="No keys yet"
                body="Create one to call the gateway from a client, a script or another phone."
                action={<Button label="Create a key" icon="plus" onPress={() => setCreating(true)} />}
              />
            )
          }
          renderItem={({ item }) => (
            <ListRow
              icon="key-variant"
              title={item.name}
              subtitle={[item.hint, item.createdAt ? `created ${relativeTime(item.createdAt)}` : '']
                .filter(Boolean)
                .join(' · ')}
              detail={item.requests !== undefined ? `${item.requests} req` : undefined}
              onPress={() => setSelected(item)}
            />
          )}
        />
      )}

      <Sheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New API key"
        subtitle="The gateway shows the secret once, right after creating it."
        footer={<Button label="Create" icon="check" loading={busy} onPress={submit} />}
      >
        <Field
          label="Name"
          value={newName}
          onChange={setNewName}
          placeholder="Phone, laptop, CI…"
          autoFocus
          hint="A name you will recognise when you revoke it later."
        />
      </Sheet>

      <Sheet
        visible={created !== null}
        onClose={() => setCreated(null)}
        title="Copy this key now"
        subtitle="It will not be shown again — the list only keeps a hint."
        footer={
          created?.secret ? (
            <Button label="Copy key" icon="content-copy" onPress={() => copy(created.secret ?? '')} />
          ) : undefined
        }
      >
        <Card>
          <KeyValue label="name" value={created?.name ?? ''} />
          <KeyValue label="key" value={created?.secret ?? ''} />
        </Card>
      </Sheet>

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        subtitle={selected?.id}
        footer={
          selected ? (
            <View style={styles.sheetActions}>
              {selected.secret ? (
                <Button
                  label="Copy secret"
                  variant="secondary"
                  icon="content-copy"
                  onPress={() => copy(selected.secret ?? '')}
                />
              ) : null}
              <Button label="Revoke" variant="danger" icon="delete-outline" onPress={() => revoke(selected)} />
            </View>
          ) : undefined
        }
      >
        {selected ? (
          <>
            <View style={styles.sheetRow}>
              {selected.hint ? <Badge label={selected.hint} tone="accent" /> : null}
              {selected.createdAt ? <Badge label={`created ${relativeTime(selected.createdAt)}`} /> : null}
              {selected.lastUsedAt ? <Badge label={`used ${relativeTime(selected.lastUsedAt)}`} tone="ok" /> : null}
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
  list: { padding: 14, paddingBottom: 64 },
  newBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  sheetActions: { flexDirection: 'row', gap: 8 },
});
