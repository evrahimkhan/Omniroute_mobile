/**
 * Shared pieces for the generic surface renderers.
 *
 * A surface screen is a header, a state (loading / error / empty / content) and a
 * body. Keeping the states here means each renderer only has to draw its own
 * content, and every one of them inherits the rule that a gateway which is down
 * produces a readable sentence rather than a blank screen.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, ErrorState, Loading, Screen, uiStyles } from '../ui/kit';
import { theme } from '../../lib/theme';

export interface SurfaceChrome {
  title: string;
  subtitle?: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function SurfaceLoading({ label = 'Loading…' }: { label?: string }) {
  return <Loading label={label} />;
}

export function SurfaceError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <ErrorState message={message} onRetry={onRetry} />;
}

/** A label above a group of rows — the dashboard's own section titles. */
export function Group({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <View style={styles.group}>
      <View style={styles.groupHead}>
        <Text style={styles.groupTitle}>{title}</Text>
        {hint ? <Text style={styles.groupHint}>{hint}</Text> : null}
      </View>
      <Card>{children}</Card>
    </View>
  );
}

/** A single number with its label, used by the stats renderer. */
export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel} numberOfLines={2}>
        {label}
      </Text>
      {hint ? (
        <Text style={styles.metricHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A proportional bar, so a breakdown is legible without a chart library. */
export function BarRow({
  label,
  value,
  ratio,
  detail,
}: {
  label: string;
  value: string;
  ratio: number;
  detail?: string;
}) {
  const width = `${Math.max(2, Math.min(100, Math.round(ratio * 100)))}%` as const;
  return (
    <View style={styles.barRow}>
      <View style={styles.barHead}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.barValue}>{value}</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width }]} />
      </View>
      {detail ? (
        <Text style={styles.barDetail} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <Text style={styles.note}>{children}</Text>;
}

export function ScrollScreen({ children }: { children: React.ReactNode }) {
  return <Screen scroll>{children}</Screen>;
}

export { uiStyles, theme };

const styles = StyleSheet.create({
  group: { marginTop: 18 },
  groupHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 8 },
  groupTitle: { color: theme.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase' },
  groupHint: { color: theme.textMuted, fontSize: 11, flexShrink: 1, textAlign: 'right' },
  metric: {
    flex: 1,
    minWidth: '45%',
    paddingVertical: 10,
  },
  metricValue: { color: theme.text, fontSize: 20, fontWeight: '700' },
  metricLabel: { color: theme.textMuted, fontSize: 11, letterSpacing: 0.8, marginTop: 2, textTransform: 'uppercase' },
  metricHint: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  barRow: { paddingVertical: 8 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barLabel: { color: theme.text, fontSize: 14, flexShrink: 1, paddingRight: 8 },
  barValue: { color: theme.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: theme.surfaceAlt, marginTop: 6, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: theme.accent },
  barDetail: { color: theme.textMuted, fontSize: 11, marginTop: 4 },
  note: { color: theme.textMuted, fontSize: 13, lineHeight: 19, paddingHorizontal: 2, paddingVertical: 6 },
});
