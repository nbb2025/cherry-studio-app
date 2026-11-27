import { Button } from '@cherrystudio/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { useAccount, useIagent } from '@/frontend/appShell/account';
import { StartupInteractiveMarker } from '@/frontend/appShell/observability';

import { ChatScreen } from './ChatScreen';

export function IagentChatScreen() {
  const { t } = useTranslation();
  const { state } = useAccount();
  const iagent = useIagent();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ['iagent', 'catalog', state.iagentUserId],
    queryFn: async () => {
      const count = await iagent.listModels();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['/models'] }),
        queryClient.invalidateQueries({ queryKey: ['/providers'] }),
      ]);
      return count;
    },
    refetchOnWindowFocus: 'always',
    refetchInterval: state.isSignedIn ? 60_000 : false,
    retry: false,
  });

  return (
    <>
      <StartupInteractiveMarker />
      <ChatScreen />
      {state.isSignedIn && (catalog.isError || catalog.data === 0) ? (
        <View className="flex-row items-center justify-between gap-2 border-t border-border bg-background px-4 py-2">
          <Text className="flex-1 text-sm text-muted-foreground">
            {t(catalog.isError ? 'iagent.catalogFailed' : 'iagent.noModels')}
          </Text>
          <Button
            disabled={catalog.isFetching}
            onPress={() => void catalog.refetch()}
            variant="ghost"
          >
            {t('common.retry')}
          </Button>
        </View>
      ) : null}
    </>
  );
}
