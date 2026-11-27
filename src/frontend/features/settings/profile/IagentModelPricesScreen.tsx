import { ContentState, Section, Tabs } from '@cherrystudio/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { useAccount, useIagent } from '@/frontend/appShell/account';
import { InlineSearch } from '@/frontend/components/InlineSearch';
import type { IagentPriceField, IagentPriceUnit } from '@/shared/contracts/iagent';

import { SettingsScrollPage } from '../components/SettingsScrollPage';

const fields = {
  input: 'settings.provider.models.pricing.input',
  output: 'settings.provider.models.pricing.output',
  cacheRead: 'settings.provider.models.pricing.cacheRead',
  cacheWrite: 'settings.provider.models.pricing.cacheWrite',
  cacheWriteHour: 'iagent.prices.cacheWriteHour',
  imageInput: 'iagent.prices.imageInput',
  imageOutput: 'iagent.prices.imageOutput',
  generation: 'iagent.prices.generation',
} as const satisfies Record<IagentPriceField, string>;

const units = {
  tokens: 'settings.provider.models.pricing.unit',
  imageTokens: 'iagent.prices.imageTokens',
  image: 'iagent.prices.perImage',
  second: 'iagent.prices.perSecond',
  video: 'iagent.prices.perVideo',
  request: 'iagent.prices.perRequest',
} as const satisfies Record<IagentPriceUnit, string>;

export function IagentModelPricesScreen() {
  const { t, i18n } = useTranslation();
  const iagent = useIagent();
  const { state } = useAccount();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number>();
  const [mode, setMode] = useState<'effective' | 'base'>('effective');
  const result = useQuery({
    queryKey: ['iagent', 'model-prices', state.iagentUserId ?? null, i18n.resolvedLanguage],
    queryFn: ({ signal }) => iagent.getModelPrices(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 8,
  });
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 5 });
  const keyword = search.trim().toLowerCase();
  const groups = (result.data ?? [])
    .map((group) => ({
      ...group,
      models: group.name.toLowerCase().includes(keyword)
        ? group.models
        : group.models.filter(({ id, name }) => `${id} ${name}`.toLowerCase().includes(keyword)),
    }))
    .filter(({ models }) => models.length);

  return (
    <SettingsScrollPage
      contentClassName="gap-4"
      headerProps={{ title: t('iagent.prices.title') }}
      search={<InlineSearch onChangeText={setSearch} value={search} />}
    >
      <Tabs
        accessibilityLabel={t('iagent.prices.title')}
        items={[
          { label: t('iagent.prices.effective'), value: 'effective' as const },
          { label: t('iagent.prices.base'), value: 'base' as const },
        ]}
        onValueChange={setMode}
        value={mode}
      />
      {result.isPending ? <ContentState.Loading /> : null}
      {result.isError && !result.data ? (
        <ContentState.Error
          title={t('iagent.catalogFailed')}
          primaryAction={{ children: t('common.retry'), onPress: () => void result.refetch() }}
        />
      ) : null}
      {result.data && !groups.length ? (
        <Text className="text-muted-foreground">{t('settings.provider.search.empty')}</Text>
      ) : null}
      {groups.map((group) => (
        <View className="gap-2" key={group.id}>
          <Section>
            <Section.Item
              accessibilityState={{ expanded: expanded === group.id }}
              description={`×${number.format(group.rate)}`}
              label={group.name}
              onPress={() =>
                setExpanded((current) => (current === group.id ? undefined : group.id))
              }
              testID={`iagent-price-group-${group.id}`}
            />
          </Section>
          {expanded === group.id ? (
            <View className="gap-2" testID="iagent-price-models">
              {group.models.map((model) => (
                <View
                  className="gap-2 rounded-2xl bg-card px-4 py-3"
                  key={`${model.platform}:${model.id}`}
                >
                  <View className="gap-1">
                    <Text className="font-semibold text-base text-foreground">{model.name}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {[
                        model.platform,
                        mode === 'effective' ? `×${number.format(model.rate)}` : undefined,
                        model.reference && model.prices.length
                          ? t('iagent.prices.reference')
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  {model.prices.length ? (
                    model.prices.map(({ field, unit, usd, detail }) => (
                      <View
                        className="flex-row flex-wrap justify-between gap-x-2 gap-y-0.5"
                        key={JSON.stringify([field, unit, usd, detail])}
                      >
                        <Text className="text-sm text-muted-foreground">
                          {[detail, t(fields[field])].filter(Boolean).join(' · ')}
                        </Text>
                        <Text className="text-right text-sm text-foreground">
                          {money.format(usd * (mode === 'effective' ? model.rate : 1))}
                          {unit === 'tokens' ? ' ' : ' / '}
                          {t(units[unit])}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text className="text-sm text-muted-foreground">
                      {t('iagent.prices.unavailable')}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </SettingsScrollPage>
  );
}
