/**
 * A list surface: rows, a search box, and a detail sheet.
 *
 * The dashboard has dozens of these — webhooks, conversations, audit entries,
 * plugins, batch jobs, CLI agents. Rather than one screen per route, the app
 * renders whatever the route returns: a title from the first human-looking
 * field, state as badges, and every other scalar in the detail view. Nothing is
 * invented and nothing is hidden: a record the app cannot label still opens.
 */

import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Badge, EmptyState, ListRow, KeyValue, uiStyles } from '../ui/kit';
import { Sheet } from '../ui/Sheet';
import { type Collection, type CollectionRow, RENDER_LIMIT } from '../../lib/api/collection';
import { theme } from '../../lib/theme';
import { Note } from './chrome';

export function CollectionBody({
  collection,
  query,
  onQuery,
  refreshing,
  onRefresh,
  emptyHint,
}: {
  collection: Collection;
  query: string;
  onQuery: (next: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState<CollectionRow | null>(null);

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

  if (!collection.rows.length) {
    return (
      <EmptyState
        icon="inbox-outline"
        title="Nothing here yet"
        body={emptyHint ?? 'This route answered with an empty list. It fills up as the gateway does work — for example once requests are made or a job is queued.'}
      />
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
          query || collection.total !== undefined ? (
            <View style={styles.listHead}>
              <Text style={styles.count}>
                {shown.length}
                {collection.total !== undefined && collection.total !== shown.length ? ` of ${collection.total}` : ''}{' '}
                {shown.length === 1 ? 'record' : 'records'}
                {query ? ` matching “${query}”` : ''}
              </Text>
            </View>
          ) : null
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
            onPress={() => setOpen(item)}
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
        onClose={() => setOpen(null)}
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
          {open?.values.map((value) => (
            <KeyValue key={value.label} label={value.label} value={value.value} />
          ))}
          {open && open.values.length === 0 ? <Note>This record has no scalar fields to show.</Note> : null}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  listHead: { paddingVertical: 8 },
  count: { color: theme.textMuted, fontSize: 12 },
  badges: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  sheet: { paddingVertical: 4 },
  sheetBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 8 },
});
