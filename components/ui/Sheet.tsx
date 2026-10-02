/**
 * The native bottom sheet, and the app's confirm/prompt dialogs.
 *
 * These replace the WebView's own menus and modals. A sheet is used where the
 * dashboard would have pushed a route or opened a drawer (a provider's detail, a
 * log entry's payload, a create form); `confirm` and `prompt` are used where it
 * would have called `window.confirm` — which is worth replacing precisely
 * because `window.confirm` does not exist in a native shell, so anything in the
 * dashboard behind one was silently dead in the old app.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { theme } from '../../lib/theme';

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  fullHeight,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** For forms and long details; half-height is the default. */
  fullHeight?: boolean;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.sheet, fullHeight && styles.sheetFull]}
        >
          <View style={styles.handle} />
          <View style={styles.sheetHead}>
            <View style={styles.sheetTitles}>
              <Text style={styles.sheetTitle} numberOfLines={2}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.sheetSubtitle} numberOfLines={2}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <MaterialCommunityIcons name="close" size={22} color={theme.textMuted} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.sheetBody}
            contentContainerStyle={styles.sheetBodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/**
 * A two-answer question, as a promise.
 *
 * Being a promise is the point: a destructive action reads as
 * `if (await confirm({...})) doIt()` in the caller, with no state machine.
 */
export function confirm(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(options.title, options.message, [
      { text: options.cancelLabel ?? 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: options.confirmLabel ?? 'OK',
        style: options.destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/**
 * A one-field question, as a promise resolving to the typed value or null.
 *
 * Alert.prompt is iOS-only, so this is a real sheet with a real TextInput — which
 * is also why it can do multi-line text and a numeric keyboard.
 */
export function PromptSheet({
  visible,
  title,
  subtitle,
  label,
  placeholder,
  initialValue = '',
  secure,
  confirmLabel = 'Save',
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  secure?: boolean;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      title={title}
      subtitle={subtitle}
      footer={
        <View style={styles.footerRow}>
          <Pressable style={[styles.footerBtn, styles.footerCancel]} onPress={onCancel}>
            <Text style={styles.footerCancelLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.footerBtn, styles.footerConfirm]}
            onPress={() => onSubmit(value.trim())}
            accessibilityRole="button"
          >
            <Text style={styles.footerConfirmLabel}>{confirmLabel}</Text>
          </Pressable>
        </View>
      }
    >
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    maxHeight: '78%',
    backgroundColor: theme.bg,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: theme.border,
    paddingBottom: 8,
  },
  sheetFull: { maxHeight: '94%', minHeight: '70%' },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginTop: 8,
    marginBottom: 4,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  sheetTitles: { flex: 1, gap: 3 },
  sheetTitle: { color: theme.text, fontSize: 17, fontWeight: '800' },
  sheetSubtitle: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  sheetBody: { paddingHorizontal: 16 },
  sheetBodyContent: { paddingBottom: 16, gap: 10 },
  sheetFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    padding: 12,
  },
  footerRow: { flexDirection: 'row', gap: 8 },
  footerBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12 },
  footerCancel: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  footerConfirm: { backgroundColor: theme.accent },
  footerCancelLabel: { color: theme.text, fontWeight: '700', fontSize: 13 },
  footerConfirmLabel: { color: '#0b0f1a', fontWeight: '800', fontSize: 13 },

  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  input: {
    marginTop: 6,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
});
