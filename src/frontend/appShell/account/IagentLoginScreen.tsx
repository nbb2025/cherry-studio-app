import CheckIcon from '@cherrystudio/app-icons/icons/check';
import XIcon from '@cherrystudio/app-icons/icons/x';
import { Button, ContentState, Image, Input, TextField } from '@cherrystudio/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, Text, type TextInputInstance, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getAppLogo } from '@/frontend/appShell/branding';
import { StartupInteractiveMarker } from '@/frontend/appShell/observability';
import { MarkdownText } from '@/frontend/components/MarkdownText';
import { IagentError } from '@/shared/contracts/iagent';

import { useAccount } from './useAccount';
import { useIagent } from './useIagent';

export function IagentLoginScreen() {
  const { t, i18n } = useTranslation();
  const { top, bottom } = useSafeAreaInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const passwordInput = useRef<TextInputInstance>(null);
  const confirmationInput = useRef<TextInputInstance>(null);
  const dismissed = useRef(false);
  const iagent = useIagent();
  const { state } = useAccount();
  const settings = useQuery({
    queryKey: ['iagent', 'public-settings', i18n.language],
    queryFn: ({ signal }) => iagent.getPublicSettings(signal),
    enabled: !state.isSignedIn,
    retry: false,
    staleTime: 60_000,
  });
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [deadline, setDeadline] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [isSending, setSending] = useState(false);
  const [showAgreements, setShowAgreements] = useState(false);
  const [acceptedSettings, setAcceptedSettings] = useState<typeof settings.data>();
  const [error, setError] = useState('');
  const [twoFactorTicket, setTwoFactorTicket] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');

  const close = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  useEffect(() => {
    if (focused && state.isSignedIn) close();
  }, [close, focused, state.isSignedIn]);

  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(left);
      if (!left) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const config = settings.data;
  const canRegister = Platform.OS !== 'ios' && config?.registration_enabled === true;
  const isRegistering = register && canRegister;
  const needsCode = isRegistering && config?.email_verify_enabled === true;
  const needsInvitation = isRegistering && config?.invitation_code_enabled === true;
  const documents = config?.login_agreement_documents ?? [];
  const needsAgreement = config?.login_agreement_enabled === true && documents.length > 0;
  const accepted = !needsAgreement || config === acceptedSettings;
  const needsChallenge =
    config?.turnstile_enabled || config?.tencent_captcha_enabled || config?.aliyun_captcha_enabled;
  const recipient = email.trim();
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
  const isBusy = state.isBusy || isSending;
  const isReady = Boolean(config && accepted && hasEmail && !isBusy && !needsChallenge);
  const passwordAccessibility = {
    show: t('account.showPassword'),
    hide: t('account.hidePassword'),
  };
  const canSubmit = twoFactorTicket
    ? !isBusy && /^\d{6}$/.test(twoFactorCode)
    : isReady &&
      password.length >= (isRegistering ? 6 : 1) &&
      (!isRegistering || password === confirmation) &&
      (!needsCode || (recipient === sentTo && /^\d{6}$/.test(verifyCode.trim()))) &&
      (!needsInvitation || Boolean(invitationCode.trim()));

  const sendCode = async () => {
    if (!isReady || seconds > 0) return;
    setSending(true);
    setError('');
    try {
      const wait = await iagent.sendVerificationCode(recipient);
      setSentTo(recipient);
      setVerifyCode('');
      setDeadline(Date.now() + wait * 1000);
      setSeconds(wait);
    } catch {
      setError(t('iagent.codeFailed'));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError('');
    try {
      if (twoFactorTicket) {
        await iagent.confirmTwoFactor(twoFactorTicket, twoFactorCode);
        return;
      }
      const ticket = await iagent.authenticate({
        email: recipient,
        password,
        registration: isRegistering
          ? {
              verifyCode: needsCode ? verifyCode.trim() : undefined,
              invitationCode: needsInvitation ? invitationCode.trim() : undefined,
            }
          : undefined,
      });
      if (ticket) {
        setPassword('');
        setConfirmation('');
        setTwoFactorTicket(ticket);
      }
    } catch (caught) {
      setError(
        caught instanceof IagentError && caught.code === 'totp'
          ? t('iagent.twoFactorInvalid')
          : caught instanceof IagentError && caught.code === 'challenge'
            ? t('iagent.challenge')
            : caught instanceof IagentError && caught.code === 'credentials'
              ? t('iagent.credentials')
              : caught instanceof IagentError && caught.code === 'unavailable'
                ? t('account.error.connection')
                : t('account.error.failed'),
      );
    }
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      <StartupInteractiveMarker />
      <View className="mx-auto w-full max-w-lg flex-row justify-end px-4 pt-2">
        <Button
          accessibilityLabel={t('common.close')}
          icon={<XIcon />}
          onPress={close}
          testID="iagent-login-close"
          variant="tonal"
        />
      </View>
      <KeyboardAwareScrollView
        bottomOffset={16}
        contentContainerStyle={{ paddingBottom: Math.max(bottom, 24) }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        mode="layout"
        style={styles.scroll}
      >
        <View className="mx-auto w-full max-w-lg gap-6 px-5 pt-5">
          <View className="gap-3 px-1">
            <View className="size-14 items-center justify-center rounded-2xl bg-secondary">
              <Image
                accessibilityIgnoresInvertColors
                className="size-10"
                contentFit="contain"
                source={getAppLogo()}
              />
            </View>
            <View className="gap-1">
              <Text accessibilityRole="header" className="font-semibold text-3xl text-foreground">
                {t(isRegistering ? 'iagent.register' : 'iagent.signIn')}
              </Text>
              <Text className="text-base text-muted-foreground">
                {t('iagent.signInDescription')}
              </Text>
            </View>
          </View>
          {settings.isPending ? (
            <ContentState.Loading />
          ) : settings.isError ? (
            <ContentState.Error
              title={t('account.error.connection')}
              primaryAction={{
                children: t('common.retry'),
                onPress: () => void settings.refetch(),
              }}
            />
          ) : (
            <View className="gap-4 rounded-3xl border border-border-subtle bg-card p-4">
              {twoFactorTicket ? (
                <TextField disabled={isBusy}>
                  <TextField.Label>{t('iagent.twoFactorCode')}</TextField.Label>
                  <Input
                    accessibilityLabel={t('iagent.twoFactorCode')}
                    autoFocus
                    keyboardType="number-pad"
                    onChangeText={(value) => setTwoFactorCode(value.replace(/\D/g, '').slice(0, 6))}
                    testID="iagent-two-factor-code"
                    textContentType="oneTimeCode"
                    value={twoFactorCode}
                  />
                </TextField>
              ) : (
                <>
                  <TextField disabled={isBusy}>
                    <TextField.Label>{t('iagent.email')}</TextField.Label>
                    <Input
                      accessibilityLabel={t('iagent.email')}
                      autoCapitalize="none"
                      autoComplete="email"
                      autoCorrect={false}
                      className="min-h-12"
                      keyboardType="email-address"
                      onChangeText={setEmail}
                      onSubmitEditing={() => passwordInput.current?.focus()}
                      returnKeyType="next"
                      submitBehavior="submit"
                      testID="iagent-email"
                      textContentType="username"
                      value={email}
                    />
                  </TextField>
                  <TextField disabled={isBusy}>
                    <TextField.Label>{t('account.password')}</TextField.Label>
                    <Input
                      accessibilityLabel={t('account.password')}
                      autoComplete={isRegistering ? 'new-password' : 'current-password'}
                      onChangeText={setPassword}
                      onSubmitEditing={() => {
                        if (isRegistering) confirmationInput.current?.focus();
                        else void submit();
                      }}
                      ref={passwordInput}
                      returnKeyType={isRegistering ? 'next' : 'go'}
                      submitBehavior={isRegistering ? 'submit' : 'blurAndSubmit'}
                      testID="iagent-password"
                      textContentType={isRegistering ? 'newPassword' : 'password'}
                      type="password"
                      value={password}
                      visibilityAccessibilityLabels={passwordAccessibility}
                    />
                  </TextField>
                  {isRegistering ? (
                    <TextField disabled={isBusy}>
                      <TextField.Label>{t('iagent.confirmPassword')}</TextField.Label>
                      <Input
                        accessibilityLabel={t('iagent.confirmPassword')}
                        autoComplete="new-password"
                        onChangeText={setConfirmation}
                        ref={confirmationInput}
                        type="password"
                        value={confirmation}
                        visibilityAccessibilityLabels={passwordAccessibility}
                      />
                      {confirmation && confirmation !== password ? (
                        <Text className="text-danger">{t('iagent.passwordMismatch')}</Text>
                      ) : null}
                    </TextField>
                  ) : null}
                  {needsInvitation ? (
                    <TextField disabled={isBusy}>
                      <TextField.Label>{t('iagent.invitationCode')}</TextField.Label>
                      <Input
                        accessibilityLabel={t('iagent.invitationCode')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={setInvitationCode}
                        value={invitationCode}
                      />
                    </TextField>
                  ) : null}
                  {needsCode ? (
                    <View className="flex-row items-end gap-2">
                      <View className="flex-1">
                        <TextField disabled={isBusy}>
                          <TextField.Label>{t('iagent.verificationCode')}</TextField.Label>
                          <Input
                            accessibilityLabel={t('iagent.verificationCode')}
                            autoComplete="one-time-code"
                            keyboardType="number-pad"
                            maxLength={6}
                            onChangeText={setVerifyCode}
                            value={verifyCode}
                          />
                        </TextField>
                      </View>
                      <Button
                        disabled={!isReady || seconds > 0}
                        loading={isSending}
                        onPress={() => void sendCode()}
                        variant="outline"
                      >
                        {seconds > 0
                          ? t('iagent.resendIn', { count: seconds })
                          : t('iagent.sendCode')}
                      </Button>
                    </View>
                  ) : null}
                  {needsAgreement ? (
                    <View className="gap-2">
                      <View className="flex-row flex-wrap items-center gap-x-3">
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: accepted, disabled: isBusy }}
                          className="min-h-11 flex-row items-center gap-2"
                          disabled={isBusy}
                          onPress={() => setAcceptedSettings(accepted ? undefined : config)}
                          testID="iagent-agreement-accept"
                        >
                          <View className="size-5 items-center justify-center rounded-md border border-border-strong">
                            {accepted ? <CheckIcon className="size-4 text-foreground" /> : null}
                          </View>
                          <Text className="text-sm text-foreground">
                            {t('iagent.acceptAgreement')}
                          </Text>
                        </Pressable>
                        <Button
                          onPress={() => setShowAgreements((current) => !current)}
                          size="sm"
                          variant="ghost"
                        >
                          {t(showAgreements ? 'common.close' : 'iagent.agreements')}
                        </Button>
                      </View>
                      {showAgreements
                        ? documents.map((document) => (
                            <View className="gap-2 rounded-2xl bg-secondary p-4" key={document.id}>
                              <Text
                                accessibilityRole="header"
                                className="font-semibold text-foreground"
                              >
                                {document.title}
                              </Text>
                              <MarkdownText markdown={document.content_md} />
                            </View>
                          ))
                        : null}
                    </View>
                  ) : null}
                </>
              )}
              {error || (needsChallenge && !twoFactorTicket) ? (
                <Text accessibilityLiveRegion="polite" className="text-danger">
                  {error || t('iagent.challenge')}
                </Text>
              ) : null}
              <Button
                disabled={!canSubmit}
                loading={state.isBusy}
                onPress={() => void submit()}
                size="lg"
                testID="iagent-sign-in"
              >
                {t(isRegistering ? 'iagent.register' : 'iagent.signIn')}
              </Button>
              {twoFactorTicket ? (
                <Button
                  disabled={isBusy}
                  onPress={() => {
                    setTwoFactorTicket(null);
                    setTwoFactorCode('');
                    setError('');
                  }}
                  variant="ghost"
                >
                  {t('common.back')}
                </Button>
              ) : canRegister ? (
                <Button
                  disabled={isBusy}
                  onPress={() => {
                    setRegister(!isRegistering);
                    setError('');
                  }}
                  variant="ghost"
                >
                  {t(isRegistering ? 'iagent.signIn' : 'iagent.register')}
                </Button>
              ) : null}
            </View>
          )}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({ scroll: { flex: 1 } });
