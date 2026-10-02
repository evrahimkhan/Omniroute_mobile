import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import ScreenHeader from '../components/ScreenHeader';
import { Button, Card, Field, ListRow, Screen, SectionHeader } from '../components/ui/kit';
import { useToast } from '../components/ui/Toast';
import { describeError, useApiContext } from '../lib/api/context';
import { explainAuthFailure } from '../lib/api/auth';
import { ApiError } from '../lib/api/client';
import { hostOf } from '../lib/gateway';
import { useSettings } from '../lib/useSettings';
import { theme } from '../lib/theme';

/**
 * Signing in to the gateway, natively.
 *
 * A local gateway in bootstrap mode needs no session — loopback requests are
 * trusted, and that is the normal case on this phone. This screen exists for the
 * other case: a management password has been set, and the app has to hold a
 * dashboard session the way the browser did with a cookie. React Native has no
 * cookie jar, so the cookie from the login response is captured and replayed
 * (see lib/api/auth.ts).
 */
export default function SignInScreen() {
  const { api, session } = useApiContext();
  const { settings } = useSettings();
  const { showToast } = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await session.signIn(password);
      setPassword('');
      showToast('Signed in — the session is kept on this device', 'ok');
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? 'That password was not accepted.'
          : describeError(err)
      );
    } finally {
      setBusy(false);
    }
  };

  const status = session.authenticated;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Dashboard session" subtitle={hostOf(settings.serverUrl)} />
      <Screen scroll>
        <View style={styles.banner}>
          <MaterialCommunityIcons
            name={status === false ? 'lock-outline' : 'shield-check-outline'}
            size={22}
            color={status === false ? '#f5a524' : theme.success}
          />
          <Text style={styles.bannerText}>
            {status === false
              ? 'The gateway asked for a session, so a management password has been set on it.'
              : 'The gateway is answering this app. A session is only needed once a management password exists.'}
          </Text>
        </View>

        {status === false ? (
          <>
            <SectionHeader title="SIGN IN" />
            <Card>
              <View style={styles.cardBody}>
                <Field
                  label="Management password"
                  value={password}
                  onChange={setPassword}
                  secure
                  placeholder="The password set on the gateway"
                  hint="Sent to your gateway only — over loopback it never leaves the phone."
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Button label="Sign in" icon="login" loading={busy} onPress={submit} />
              </View>
            </Card>
            <Text style={styles.note}>
              {explainAuthFailure(401, hostOf(settings.serverUrl))}
            </Text>
          </>
        ) : (
          <>
            <SectionHeader title="SESSION" />
            <Card>
              <ListRow
                icon="check-circle-outline"
                iconColor={theme.success}
                title="Nothing to do"
                subtitle="The gateway is answering without a password. If you set one later, come back here."
              />
            </Card>
          </>
        )}

        <SectionHeader title="IF SIGNING IN FAILS" />
        <Card>
          <ListRow
            icon="information-outline"
            title="Is the address the phone itself?"
            subtitle="Only http://127.0.0.1:20128 is trusted as local. A LAN or tunnel address is treated as a remote client and always needs credentials."
          />
          <ListRow
            icon="open-in-new"
            title="Set the password from the dashboard"
            subtitle="A gateway with no password at all cannot authenticate anyone — set one there first."
          />
        </Card>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 13,
    marginBottom: 4,
  },
  bannerText: { color: theme.text, fontSize: 13, lineHeight: 18, flex: 1 },
  cardBody: { padding: 12, gap: 12 },
  error: { color: theme.danger, fontSize: 12, lineHeight: 17 },
  note: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 10, paddingHorizontal: 4 },
});
