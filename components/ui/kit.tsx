/**
 * Native UI primitives.
 *
 * The app used to render the gateway's dashboard in a WebView, where every menu,
 * dialog and list belonged to the page. These are the equivalents the screens are
 * built from now, so a sheet, a chip, a confirmation and a toast look and behave
 * the same everywhere — and nothing here reaches for a browser.
 *
 * Deliberately dependency-free: React Native primitives, the icon set already in
 * the bundle, and the app's theme. A UI kit is exactly the wrong place to add a
 * library the APK has to carry.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { theme } from '../../lib/theme';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

// --------------------------------------------------------------- containers

export function Screen({
  children,
  scroll = false,
  padded = true,
  style,
  refreshControl,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const inner = padded ? [styles.screenPadding, style] : style;
  if (scroll) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.screenPadding, styles.scrollContent, style]}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
      >
        {children}
      </ScrollView>
    );
  }
  return <View style={[styles.screen, inner]}>{children}</View>;
}

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

// -------------------------------------------------------------------- rows

export function ListRow({
  title,
  subtitle,
  detail,
  icon,
  iconColor = theme.accent,
  right,
  onPress,
  onLongPress,
  disabled,
  centered,
}: {
  title: string;
  subtitle?: string;
  detail?: string;
  icon?: IconName;
  iconColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  centered?: boolean;
}) {
  const content = (
    <>
      {icon ? (
        <View style={styles.rowIcon}>
          <MaterialCommunityIcons name={icon} size={19} color={iconColor} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, centered && styles.centered]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.rowSubtitle, centered && styles.centered]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      {right}
      {onPress ? (
        <MaterialCommunityIcons name="chevron-right" size={18} color={theme.textMuted} style={styles.chevron} />
      ) : null}
    </>
  );

  if (!onPress && !onLongPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      {content}
    </Pressable>
  );
}

// ------------------------------------------------------------------ pieces

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  icon?: IconName;
}) {
  const color =
    tone === 'ok' ? theme.success : tone === 'warn' ? '#f5a524' : tone === 'danger' ? theme.danger : theme.text;
  return (
    <View style={styles.statTile}>
      <View style={styles.statHead}>
        {icon ? <MaterialCommunityIcons name={icon} size={14} color={theme.textMuted} /> : null}
        <Text style={styles.statLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.statHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Badge({
  label,
  tone = 'muted',
  icon,
}: {
  label: string;
  tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent';
  icon?: IconName;
}) {
  const map = {
    muted: { bg: theme.surfaceAlt, fg: theme.textMuted },
    ok: { bg: 'rgba(52, 211, 153, 0.14)', fg: theme.success },
    warn: { bg: 'rgba(245, 165, 36, 0.14)', fg: '#f5a524' },
    danger: { bg: 'rgba(248, 113, 113, 0.14)', fg: theme.danger },
    accent: { bg: theme.accentSoft, fg: theme.accent },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: map.bg }]}>
      {icon ? <MaterialCommunityIcons name={icon} size={11} color={map.fg} /> : null}
      <Text style={[styles.badgeLabel, { color: map.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      {icon ? (
        <MaterialCommunityIcons name={icon} size={13} color={selected ? '#0b0f1a' : theme.textMuted} />
      ) : null}
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const base = [styles.button, styles[`button_${variant}` as const], style];
  const labelStyle: StyleProp<TextStyle> =
    variant === 'primary' || variant === 'danger' ? styles.buttonLabelDark : styles.buttonLabel;
  const tint = variant === 'primary' || variant === 'danger' ? '#0b0f1a' : theme.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      style={({ pressed }) => [base, pressed && styles.pressed, (disabled || loading) && styles.rowDisabled]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tint} />
      ) : icon ? (
        <MaterialCommunityIcons name={icon} size={17} color={tint} />
      ) : null}
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  return (
    <View style={styles.search}>
      <MaterialCommunityIcons name="magnify" size={18} color={theme.textMuted} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        accessibilityLabel={placeholder}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityLabel="Clear search">
          <MaterialCommunityIcons name="close-circle" size={17} color={theme.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  autoFocus,
  keyboardType = 'default',
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  secure?: boolean;
  autoFocus?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric' | 'email-address';
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        secureTextEntry={secure}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: theme.surfaceAlt, true: theme.accent }}
        thumbColor={theme.text}
      />
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.keyValueText} selectable numberOfLines={4}>
        {value}
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------- states

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.stateBox}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={styles.stateText}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  icon = 'inbox-outline',
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.stateBox}>
      <MaterialCommunityIcons name={icon} size={40} color={theme.textMuted} />
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateText}>{body}</Text> : null}
      {action ? <View style={styles.stateAction}>{action}</View> : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  action,
  title = 'That did not work',
}: {
  message: string;
  onRetry?: () => void;
  /** A way out of the failure, when retrying is not the answer. */
  action?: { label: string; icon?: IconName; onPress: () => void };
  title?: string;
}) {
  return (
    <View style={styles.stateBox}>
      <MaterialCommunityIcons name="alert-circle-outline" size={40} color={theme.danger} />
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateText}>{message}</Text>
      {onRetry || action ? (
        <View style={styles.stateAction}>
          {onRetry ? <Button label="Try again" icon="refresh" onPress={onRetry} variant={action ? 'secondary' : 'primary'} /> : null}
          {action ? <Button label={action.label} icon={action.icon ?? 'cog-outline'} onPress={action.onPress} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  screenPadding: { padding: 14 },
  scrollContent: { paddingBottom: 96 },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionTitle: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginVertical: 2 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderRadius: 12,
  },
  rowPressed: { backgroundColor: theme.surfaceAlt },
  rowDisabled: { opacity: 0.45 },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accentSoft,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: theme.text, fontSize: 14, fontWeight: '600' },
  rowSubtitle: { color: theme.textMuted, fontSize: 12, lineHeight: 16 },
  rowDetail: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  chevron: { marginLeft: -2 },
  centered: { textAlign: 'center' },
  stateBox: { alignItems: 'center', justifyContent: 'center', padding: 28, gap: 6, minHeight: 200 },

  statTile: {
    flex: 1,
    minWidth: 104,
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    gap: 2,
  },
  statHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, flexShrink: 1 },
  statValue: { fontSize: 20, fontWeight: '800' },
  statHint: { color: theme.textMuted, fontSize: 11 },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: 150,
  },
  badgeLabel: { fontSize: 11, fontWeight: '700' },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    maxWidth: 200,
  },
  chipSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipLabel: { color: theme.text, fontSize: 12, fontWeight: '600' },
  chipLabelSelected: { color: '#0b0f1a', fontWeight: '800' },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: theme.border,
  },
  button_primary: { backgroundColor: theme.accent, borderColor: theme.accent },
  button_secondary: { backgroundColor: theme.bg },
  button_danger: { backgroundColor: theme.danger, borderColor: theme.danger },
  button_ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  buttonLabel: { color: theme.text, fontWeight: '700', fontSize: 13 },
  buttonLabelDark: { color: '#0b0f1a', fontWeight: '800', fontSize: 13 },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: 14, padding: 0 },

  field: { gap: 6 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  fieldHint: { color: theme.textMuted, fontSize: 11, lineHeight: 15 },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 10 },

  keyValue: { paddingVertical: 6, gap: 2 },
  keyValueLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  keyValueText: { color: theme.text, fontSize: 13 },

  stateTitle: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  stateText: { color: theme.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19, paddingHorizontal: 12 },
  stateAction: { marginTop: 12, flexDirection: 'row', gap: 8 },
  pressed: { opacity: 0.85 },
});

/** The raw styles, for screens that need to compose them. */
export const uiStyles = styles;
