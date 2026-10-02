/**
 * A settings surface: read the object, edit it with native controls, write back
 * only what changed.
 *
 * The dashboard spends a page per settings screen on this. Here it is one
 * renderer over the payload the gateway already returns, which means the app
 * gains the ability to *edit* configuration — not just look at it — without a
 * bespoke form per route. Fields the gateway describes itself (label, type,
 * enum, requiresRestart) are drawn from that description; anything else is
 * inferred from the value's type and labelled from its key.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Button, Card, Chip, Field, ToggleRow, uiStyles } from '../ui/kit';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { useApi } from '../../lib/api/context';
import { configGroups, countEditable, saveConfig, type ConfigField, type ConfigGroup } from '../../lib/api/config';
import { humanizeKey } from '../../lib/screens/format';
import { theme } from '../../lib/theme';
import { Group, Note } from './chrome';

export function ConfigBody({
  path,
  method,
  payload,
  reload,
}: {
  path: string;
  method: 'patch' | 'post' | 'put';
  payload: unknown;
  reload: () => Promise<void>;
}) {
  const api = useApi();
  const { showToast } = useToast();
  const groups = useMemo(() => configGroups(payload), [payload]);

  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [openEnum, setOpenEnum] = useState<ConfigField | null>(null);

  const dirty = Object.keys(edits).length > 0;
  const editable = countEditable(groups);

  const valueOf = useCallback(
    (field: ConfigField) => (field.key in edits ? edits[field.key] : field.value),
    [edits]
  );

  const setEdit = useCallback((key: string, value: unknown) => {
    setEdits((current) => ({ ...current, [key]: value }));
  }, []);

  const discard = useCallback(() => setEdits({}), []);

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await saveConfig(api, path, edits, method);
      showToast(`Saved ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? '' : 's'}`);
      setEdits({});
      await reload();
    } catch (error) {
      // The gateway's own message is the useful part; the client already
      // extracted it from whichever error shape it returned.
      showToast(error instanceof Error ? error.message : 'Could not save', 'danger');
    } finally {
      setSaving(false);
    }
  }, [api, dirty, edits, method, path, reload, showToast]);

  if (!groups.length) {
    return (
      <Card>
        <Note>
          This route answered with nothing to configure. The app shows what it returns on the surface’s main view; an
          empty answer usually means the feature is off or has not been initialised yet.
        </Note>
      </Card>
    );
  }

  return (
    <>
      {editable === 0 ? (
        <Card>
          <Note>
            Everything here is reported by the gateway but not editable from the app — these are read-only values such as
            secrets or derived state. Editing them belongs in the gateway’s own configuration file.
          </Note>
        </Card>
      ) : null}

      {groups.map((group) => (
        <ConfigGroupCard
          key={group.title}
          group={group}
          valueOf={valueOf}
          onChange={setEdit}
          onOpenEnum={setOpenEnum}
        />
      ))}

      {dirty ? (
        <View style={styles.saveBar}>
          <Button
            label={saving ? 'Saving…' : `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? '' : 's'}`}
            icon="content-save-outline"
            onPress={save}
            loading={saving}
          />
          <Button label="Discard" variant="ghost" onPress={discard} disabled={saving} />
        </View>
      ) : (
        <View style={styles.savedRow}>
          <MaterialCommunityIcons name="check-circle-outline" size={15} color={theme.textMuted} />
          <Text style={styles.savedText}>In step with the gateway</Text>
        </View>
      )}

      <EnumSheet field={openEnum} onClose={() => setOpenEnum(null)} onPick={(value) => {
        if (openEnum) setEdit(openEnum.key, value);
        setOpenEnum(null);
      }} />
    </>
  );
}

function ConfigGroupCard({
  group,
  valueOf,
  onChange,
  onOpenEnum,
}: {
  group: ConfigGroup;
  valueOf: (field: ConfigField) => unknown;
  onChange: (key: string, value: unknown) => void;
  onOpenEnum: (field: ConfigField) => void;
}) {
  return (
    <Group title={group.title}>
      {group.fields.map((field, index) => (
        <View key={field.key} style={index > 0 ? styles.rowBorder : undefined}>
          <ConfigFieldRow field={field} value={valueOf(field)} onChange={onChange} onOpenEnum={onOpenEnum} />
        </View>
      ))}
    </Group>
  );
}

function ConfigFieldRow({
  field,
  value,
  onChange,
  onOpenEnum,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  onOpenEnum: (field: ConfigField) => void;
}) {
  const restart = field.requiresRestart ? 'Needs a restart to take effect' : undefined;
  const source = field.source && field.source !== 'db' ? `from ${field.source}` : undefined;
  const subtitle = [field.description, restart, source].filter(Boolean).join(' · ') || undefined;

  if (field.readOnly) {
    return (
      <View style={styles.readonly}>
        <Text style={styles.readonlyLabel}>{field.label}</Text>
        <Text style={styles.readonlyValue} numberOfLines={2}>
          {value === undefined || value === null || value === '' ? '—' : String(value)}
        </Text>
        {subtitle ? <Text style={styles.readonlyHint}>{subtitle}</Text> : null}
      </View>
    );
  }

  if (field.type === 'boolean') {
    return (
      <ToggleRow
        title={field.label}
        subtitle={subtitle}
        value={value === true}
        onChange={(next) => onChange(field.key, next)}
      />
    );
  }

  if (field.type === 'enum' && field.options?.length) {
    return (
      <View style={styles.enumRow}>
        <Text style={styles.enumLabel}>{field.label}</Text>
        {subtitle ? <Text style={styles.enumHint}>{subtitle}</Text> : null}
        <View style={styles.chips}>
          {field.options.slice(0, 8).map((option) => (
            <Chip
              key={option}
              label={humanizeKey(option)}
              selected={String(value) === option}
              onPress={() => onChange(field.key, option)}
            />
          ))}
          {field.options.length > 8 ? (
            <Chip label={`+${field.options.length - 8} more`} selected={false} onPress={() => onOpenEnum(field)} />
          ) : null}
        </View>
      </View>
    );
  }

  if (field.type === 'number') {
    return (
      <Field
        label={field.label}
        hint={subtitle}
        value={value === undefined || value === null ? '' : String(value)}
        keyboardType="numeric"
        onChange={(next) => {
          const parsed = next.trim() === '' ? '' : Number(next);
          onChange(field.key, typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : next);
        }}
        placeholder="0"
      />
    );
  }

  return (
    <Field
      label={field.label}
      hint={subtitle}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      onChange={(next) => onChange(field.key, next)}
      placeholder={field.type === 'long' ? 'Long value' : 'Value'}
    />
  );
}

function EnumSheet({
  field,
  onClose,
  onPick,
}: {
  field: ConfigField | null;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  return (
    <Sheet visible={Boolean(field)} onClose={onClose} title={field?.label ?? 'Choose'} subtitle={field?.description}>
      <View style={styles.sheetBody}>
        {field?.options?.map((option) => (
          <Chip key={option} label={humanizeKey(option)} selected={String(field.value) === option} onPress={() => onPick(option)} />
        ))}
      </View>
    </Sheet>
  );
}

/** A spinner is enough while a save round-trips; the sheet below stays mounted. */
export function SavingHint() {
  return <ActivityIndicator color={theme.accent} />;
}

const styles = StyleSheet.create({
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  saveBar: { marginTop: 20, gap: 8 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, paddingHorizontal: 2 },
  savedText: { color: theme.textMuted, fontSize: 12 },
  readonly: { paddingVertical: 10 },
  readonlyLabel: { color: theme.text, fontSize: 14 },
  readonlyValue: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  readonlyHint: { color: theme.textMuted, fontSize: 11, marginTop: 3 },
  enumRow: { paddingVertical: 10 },
  enumLabel: { color: theme.text, fontSize: 14 },
  enumHint: { color: theme.textMuted, fontSize: 11, marginTop: 3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  sheetBody: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8 },
});
