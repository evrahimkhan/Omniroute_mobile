import React, { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import ScreenHeader from '../components/ScreenHeader';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValue,
  ListRow,
  Loading,
  SectionHeader,
  uiStyles,
} from '../components/ui/kit';
import { Sheet } from '../components/ui/Sheet';
import { useApiContext, usePolling } from '../lib/api/context';
import { getCombos, type Combo } from '../lib/api/resources';
import { scalarFields } from '../lib/api/shape';
import { theme } from '../lib/theme';

/**
 * Combos — grouped providers used for failover, natively.
 *
 * Read-only on purpose. A combo's editor is a builder (drag order, per-step
 * conditions, weights) and inventing a cut-down version of it on a phone would
 * produce settings that look simpler than they are. What the app offers is what
 * the phone is good at: seeing what exists, what is in it, and copying a name
 * into a client. Creating and editing stays where it belongs.
 */
export default function CombosScreen() {
  const { api, waiting } = useApiContext();
  const [selected, setSelected] = useState<Combo | null>(null);
  const combos = usePolling(api ? () => getCombos(api, { limit: 100 }) : null, 45_000);

  if (waiting) return <Loading label="Reading settings…" />;

  return (
    <View style={uiStyles.screen}>
      <ScreenHeader title="Combos" subtitle="Groups of providers used for failover" />

      {!api ? (
        <EmptyState icon="link-off" title="No gateway configured" body="Set the gateway address in Settings first." />
      ) : combos.error && !combos.data ? (
        <ErrorState message={combos.error} onRetry={combos.reload} />
      ) : (
        <FlatList
          data={combos.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={combos.loading} onRefresh={combos.reload} tintColor={theme.textMuted} />
          }
          ListEmptyComponent={
            combos.loading ? (
              <Loading label="Reading combos…" />
            ) : (
              <EmptyState
                icon="layers-triple"
                title="No combos"
                body="Combos are created in the dashboard, where the builder lives. They show up here once they exist."
              />
            )
          }
          renderItem={({ item }) => (
            <ListRow
              icon="layers-triple"
              title={item.name}
              subtitle={item.description || item.members.slice(0, 3).join(' → ') || 'no members reported'}
              detail={item.members.length ? `${item.members.length}` : undefined}
              right={item.active === undefined ? undefined : <Badge label={item.active ? 'on' : 'off'} tone={item.active ? 'ok' : 'muted'} />}
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
        fullHeight
      >
        {selected ? (
          <>
            <View style={styles.sheetRow}>
              {selected.active !== undefined ? (
                <Badge label={selected.active ? 'active' : 'inactive'} tone={selected.active ? 'ok' : 'muted'} />
              ) : null}
              <Badge label={`${selected.members.length} members`} tone="accent" />
            </View>

            {selected.members.length ? (
              <>
                <SectionHeader title="MEMBERS, IN ORDER" />
                <Card>
                  {selected.members.map((member, index) => (
                    <ListRow key={`${member}-${index}`} title={member} detail={`#${index + 1}`} icon="arrow-right-thin" />
                  ))}
                </Card>
              </>
            ) : null}

            <SectionHeader title="AS THE GATEWAY REPORTS IT" />
            <Card>
              {scalarFields(selected.raw).map((field) => (
                <KeyValue key={field.key} label={field.key} value={field.value} />
              ))}
            </Card>
            <Text style={styles.note}>
              Editing a combo is left to the dashboard: its builder has ordering and conditions that do not
              translate to a phone screen without losing meaning.
            </Text>
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 14, paddingBottom: 64 },
  sheetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  note: { color: theme.textMuted, fontSize: 11, lineHeight: 16, paddingHorizontal: 4 },
});
