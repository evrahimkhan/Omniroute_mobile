/**
 * A list surface: rows, a search box, a detail sheet, and native mutations.
 *
 * The dashboard has dozens of these — webhooks, conversations, audit entries,
 * plugins, batch jobs, CLI agents. Rather than one screen per route, the app
 * renders whatever the route returns: a title from the first human-looking
 * field, state as badges, and every other scalar in the detail view. Records can
 * be inspected, created, edited, or deleted natively.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, EmptyState, Field, ListRow, KeyValue, uiStyles } from '../ui/kit';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { useApi } from '../../lib/api/context';
import {
  type Collection,
  type CollectionRow,
  createRow,
  deleteRow,
  updateRow,
  RENDER_LIMIT,
} from '../../lib/api/collection';
import { theme } from '../../lib/theme';
import { Note } from './chrome';

export function CollectionBody({
  path,
  collection,
  query,
  onQuery,
  refreshing,
  onRefresh,
  emptyHint,
}: {
  path?: string;
  collection: Collection;
  query: string;
  onQuery: (next: string) => void;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  emptyHint?: string;
}) {
  const api = useApi();
  const { showToast } = useToast();
  const [open, setOpen] = useState<CollectionRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // New record creation
  const [creating, setCreating] = useState(false);
  const [newPayloadText, setNewPayloadText] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return collection.rows;
    return collection.rows.filter((row) =>
      [row.title, row.subtitle ?? '', ...row.values.map((value) => `${value.label} ${value.value}`)]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [collection.rows, query]);

  const shown = rows.slice(0, RENDER_LIMIT);

  const startEdit = useCallback((row: CollectionRow) => {
    const initial: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.raw)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        initial[k] = String(v);
      }
    }
    setEditValues(initial);
    setEditing(true);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!api || !path || !open) return;
    setSaving(true);
    try {
      await updateRow(api, path, open.id, editValues);
      showToast('Record updated');
      setEditing(false);
      setOpen(null);
      await onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update record', 'danger');
    } finally {
      setSaving(false);
    }
  }, [api, path, open, editValues, showToast, onRefresh]);

  const handleDelete = useCallback(async (row: CollectionRow) => {
    if (!api || !path) return;
    Alert.alert('Delete Record', `Are you sure you want to delete “${row.title}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRow(api, path, row.id);
            showToast('Record deleted');
            setOpen(null);
            await onRefresh();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete record', 'danger');
          }
        },
      },
    ]);
  }, [api, path, showToast, onRefresh]);

  const handleCreate = useCallback(async () => {
    if (!api || !path) return;
    setSaving(true);
    try {
      const data = JSON.parse(newPayloadText);
      await createRow(api, path, data);
      showToast('Record created');
      setCreating(false);
      setNewPayloadText('');
      await onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create record (ensure valid JSON)', 'danger');
    } finally {
      setSaving(false);
    }
  }, [api, path, newPayloadText, showToast, onRefresh]);

  if (!collection.rows.length) {
    return (
      <>
        <EmptyState
          icon="inbox-outline"
          title="Nothing here yet"
          body={emptyHint ?? 'This route answered with an empty list. It fills up as the gateway does work — for example once requests are made or a job is queued.'}
        />
        {path ? (
          <View style={styles.createBtnWrap}>
            <Button
              label="Add Record"
              icon="plus"
              onPress={() => setCreating(true)}
            />
          </View>
        ) : null}
        <Sheet
          visible={creating}
          onClose={() => setCreating(false)}
          title="New Record"
          subtitle={path}
        >
          <View style={styles.sheet}>
            <Field
              label="JSON Payload"
              placeholder='{"name": "example"}'
              value={newPayloadText}
              onChange={setNewPayloadText}
            />
            <View style={styles.sheetActions}>
              <Button
                label={saving ? 'Creating…' : 'Create'}
                onPress={handleCreate}
                disabled={saving || !newPayloadText.trim()}
              />
            </View>
          </View>
        </Sheet>
      </>
    );
  }

  return (
    <>
      <FlatList
        data={shown}
        keyExtractor={(row, index) => `${row.id}-${index}`}
        scrollEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textMuted} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={
          <View style={styles.listHead}>
            <Text style={styles.count}>
              {shown.length}
              {collection.total !== undefined && collection.total !== shown.length ? ` of ${collection.total}` : ''}{' '}
              {shown.length === 1 ? 'record' : 'records'}
              {query ? ` matching “${query}”` : ''}
            </Text>
            {path ? (
              <Button
                label="Add"
                icon="plus"
                variant="secondary"
                onPress={() => setCreating(true)}
              />
            ) : null}
          </View>
        }
        ListFooterComponent={
          rows.length > shown.length ? (
            <Note>
              Showing the first {shown.length} of {rows.length}. Narrow it with the search box above.
            </Note>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.title}
            subtitle={item.subtitle}
            onPress={() => {
              setEditing(false);
              setOpen(item);
            }}
            right={
              item.badges.length ? (
                <View style={styles.badges}>
                  {item.badges.slice(0, 2).map((badge) => (
                    <Badge key={badge.label} label={badge.label} tone={badge.tone} />
                  ))}
                </View>
              ) : null
            }
          />
        )}
      />

      <Sheet
        visible={Boolean(open)}
        onClose={() => {
          setOpen(null);
          setEditing(false);
        }}
        title={open?.title ?? ''}
        subtitle={open?.subtitle}
        fullHeight
      >
        <View style={styles.sheet}>
          {open?.badges.length ? (
            <View style={styles.sheetBadges}>
              {open.badges.map((badge) => (
                <Badge key={badge.label} label={badge.label} tone={badge.tone} />
              ))}
            </View>
          ) : null}

          {editing ? (
            <View style={styles.editFields}>
              {Object.entries(editValues).map(([k, v]) => (
                <Field
                  key={k}
                  label={k}
                  value={v}
                  onChange={(val) => setEditValues((prev) => ({ ...prev, [k]: val }))}
                />
              ))}
              <View style={styles.sheetActions}>
                <Button
                  label={saving ? 'Saving…' : 'Save Changes'}
                  onPress={handleSaveEdit}
                  disabled={saving}
                />
                <Button
                  label="Cancel"
                  variant="secondary"
                  onPress={() => setEditing(false)}
                />
              </View>
            </View>
          ) : (
            <>
              {open?.values.map((value) => (
                <KeyValue key={value.label} label={value.label} value={value.value} />
              ))}
              {open && open.values.length === 0 ? <Note>This record has no scalar fields to show.</Note> : null}

              {path && open ? (
                <View style={styles.sheetActions}>
                  <Button
                    label="Edit Record"
                    icon="pencil-outline"
                    variant="secondary"
                    onPress={() => startEdit(open)}
                  />
                  <Button
                    label="Delete Record"
                    icon="trash-can-outline"
                    variant="danger"
                    onPress={() => handleDelete(open)}
                  />
                </View>
              ) : null}
            </>
          )}
        </View>
      </Sheet>

      <Sheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New Record"
        subtitle={path}
      >
        <View style={styles.sheet}>
          <Field
            label="JSON Payload"
            placeholder='{"name": "example"}'
            value={newPayloadText}
            onChange={setNewPayloadText}
          />
          <View style={styles.sheetActions}>
            <Button
              label={saving ? 'Creating…' : 'Create'}
              onPress={handleCreate}
              disabled={saving || !newPayloadText.trim()}
            />
          </View>
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  listHead: { paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { color: theme.textMuted, fontSize: 12 },
  badges: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  sheet: { paddingVertical: 4 },
  sheetBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 8 },
  sheetActions: { flexDirection: 'column', gap: 10, marginTop: 16 },
  editFields: { flexDirection: 'column', gap: 12 },
  createBtnWrap: { marginTop: 16, alignItems: 'center' },
});