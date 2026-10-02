/**
 * A numbers surface: the dashboard's analytics pages, without the dashboard.
 *
 * These pages are chart-heavy in the browser. A phone does not need the chart —
 * it needs the figure, what it is made of, and which entries dominate. So the
 * payload is laid out as metrics, proportional breakdowns and key/value groups,
 * all from real data: a number is never invented to fill a tile, and a value the
 * app cannot parse is shown as text rather than dropped.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, KeyValue } from '../ui/kit';

import { parseStats, type Breakdown } from '../../lib/screens/stats';
import { BarRow, Group, Metric, Note } from './chrome';

export function StatsBody({ payload }: { payload: unknown }) {
  const parsed = useMemo(() => parseStats(payload), [payload]);

  const empty =
    !parsed.metrics.length && !parsed.breakdowns.length && !parsed.groups.length && !parsed.lists.length;

  if (empty) {
    return (
      <Card>
        <Note>
          This route answered without numbers to show. That usually means no traffic has been recorded in the window
          yet, or the feature is switched off.
        </Note>
      </Card>
    );
  }

  return (
    <>
      {parsed.metrics.length ? (
        <Group title="Numbers">
          <View style={styles.metrics}>
            {parsed.metrics.map((metric) => (
              <Metric key={metric.label} label={metric.label} value={metric.value} hint={metric.hint} />
            ))}
          </View>
        </Group>
      ) : null}

      {parsed.breakdowns.map((breakdown) => (
        <Group key={breakdown.title} title={breakdown.title}>
          {(breakdown.rows as (Breakdown['rows'][number] & { ratio?: number })[]).map((row, index) => (
            <BarRow
              key={`${row.label}-${index}`}
              label={row.label}
              value={row.display}
              ratio={row.ratio ?? 0}
              detail={row.detail}
            />
          ))}
        </Group>
      ))}

      {parsed.groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.values.map((value) => (
            <KeyValue key={`${group.title}-${value.label}`} label={value.label} value={value.value} />
          ))}
        </Group>
      ))}

      {parsed.lists.map((list) => (
        <Group key={list.title} title={`${list.title} (${list.values.length})`}>
          {list.values.map((value, index) => (
            <KeyValue key={`${list.title}-${index}`} label={String(index + 1)} value={value} />
          ))}
        </Group>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 },
});
