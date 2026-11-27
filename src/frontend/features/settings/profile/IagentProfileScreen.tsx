import ExternalLinkIcon from '@cherrystudio/app-icons/icons/external-link';
import { Button, ContentState, Section, useToast } from '@cherrystudio/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, Text, View } from 'react-native';

import { useAccount, useIagent } from '@/frontend/appShell/account';
import { IAGENT_ORIGIN } from '@/shared/contracts/iagent';

import { getNativeAppStoreUpdate } from '../../../../../modules/app-update';
import { SettingsScrollPage } from '../components/SettingsScrollPage';

const RECHARGE_URL = `${IAGENT_ORIGIN}/app/billing#recharge`;

export function IagentProfileScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const iagent = useIagent();
  const { account, state } = useAccount();
  const { toast } = useToast();
  const [isSigningOut, setSigningOut] = useState(false);
  const user = useQuery({
    queryKey: ['iagent', 'user', state.iagentUserId],
    enabled: state.isSignedIn,
    queryFn: ({ signal }) => iagent.getUser(signal),
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });
  const usage = useQuery({
    queryKey: ['iagent', 'usage', state.iagentUserId],
    enabled: state.isSignedIn,
    queryFn: ({ signal }) => iagent.getUsage(signal),
    staleTime: 0,
  });
  const recharge = useQuery({
    queryKey: ['iagent', 'website-recharge'],
    enabled: state.isSignedIn && Platform.OS === 'ios',
    queryFn: async () => (await getNativeAppStoreUpdate()?.canOpenWebsiteCheckout?.()) === true,
    refetchOnWindowFocus: 'always',
    retry: false,
    staleTime: 0,
  });
  const showRecharge = recharge.isSuccess && recharge.data;
  const { refetch: refetchUser } = user;
  const { refetch: refetchUsage } = usage;
  const refresh = useCallback(() => {
    if (!state.isSignedIn) return;
    void refetchUser();
    void refetchUsage();
  }, [refetchUser, refetchUsage, state.isSignedIn]);
  useFocusEffect(refresh);
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  });
  const openRecharge = async () => {
    const result = await recharge.refetch();
    if (!result.isSuccess || !result.data) return;
    await Linking.openURL(RECHARGE_URL).catch(() => {
      toast.show({ label: t('iagent.rechargeOpenFailed'), variant: 'danger' });
    });
  };
  const signOut = async () => {
    setSigningOut(true);
    try {
      await account.signOut();
    } catch {
      toast.show({ label: t('account.error.failed'), variant: 'danger' });
    } finally {
      setSigningOut(false);
    }
  };

  if (!state.isSignedIn) {
    return (
      <SettingsScrollPage contentClassName="gap-4" headerProps={{ title: 'iAgent' }}>
        <Text className="text-muted-foreground">{t('iagent.signInDescription')}</Text>
        <Button onPress={() => router.navigate('/login')}>{t('iagent.signIn')}</Button>
        <Button onPress={() => router.push('/settings/model-prices')} variant="outline">
          {t('iagent.prices.title')}
        </Button>
      </SettingsScrollPage>
    );
  }

  return (
    <SettingsScrollPage contentClassName="gap-6" headerProps={{ title: t('account.title') }}>
      <View className="gap-1">
        <Text accessibilityRole="header" className="font-semibold text-2xl text-foreground">
          {user.data?.username || state.name || 'iAgent'}
        </Text>
        {user.data?.email ? <Text className="text-muted-foreground">{user.data.email}</Text> : null}
      </View>
      {user.isPending || usage.isPending ? <ContentState.Loading /> : null}
      {user.isError || usage.isError ? (
        <ContentState.Error
          title={t('account.error.connection')}
          primaryAction={{ children: t('common.retry'), onPress: refresh }}
        />
      ) : null}
      {user.data || usage.data || showRecharge ? (
        <Section>
          {Number.isFinite(user.data?.balance) && user.data ? (
            <Section.Item
              label={t('iagent.balance')}
              trailing={
                <Text className="text-base text-muted-foreground">
                  {money.format(user.data.balance)}
                </Text>
              }
            />
          ) : null}
          {showRecharge ? (
            <Section.Item
              disabled={recharge.isFetching}
              label={t('iagent.rechargeOnWebsite')}
              onPress={() => void openRecharge()}
              showChevron={false}
              testID="iagent-recharge"
              trailing={<ExternalLinkIcon className="size-4 text-muted-foreground" />}
            />
          ) : null}
          {usage.data ? (
            <>
              <Section.Item
                label={t('iagent.totalRequests')}
                trailing={
                  <Text className="text-base text-muted-foreground">
                    {usage.data.totalRequests.toLocaleString(i18n.language)}
                  </Text>
                }
              />
              <Section.Item
                label={t('iagent.totalCost')}
                trailing={
                  <Text className="text-base text-muted-foreground">
                    {money.format(usage.data.totalCost)}
                  </Text>
                }
              />
            </>
          ) : null}
        </Section>
      ) : null}
      <Section>
        <Section.Item
          label={t('iagent.prices.title')}
          onPress={() => router.push('/settings/model-prices')}
        />
      </Section>
      <Button onPress={refresh} disabled={user.isFetching || usage.isFetching} variant="outline">
        {t('iagent.refresh')}
      </Button>
      <Button
        onPress={() => void Linking.openURL(IAGENT_ORIGIN).catch(() => undefined)}
        variant="ghost"
      >
        {t('common.officialWebsite')}
      </Button>
      <Button
        onPress={() => void signOut()}
        loading={isSigningOut}
        variant="outline"
        testID="iagent-sign-out"
      >
        {t('account.signOut')}
      </Button>
    </SettingsScrollPage>
  );
}
