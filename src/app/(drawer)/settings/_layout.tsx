import { Stack } from 'expo-router';

import { headerScreenOptions } from '@/frontend/appShell/header';
import { FormContentFrame } from '@/frontend/appShell/layout';
import { NavRouteHeaderScope } from '@/frontend/appShell/navigationShell';
import { DesktopPairingProvider } from '@/frontend/features/settings/DeviceConnectionsScreen';
import { useThemeColor } from '@/frontend/hooks/useThemeColor';
import { getSingleRouteParam } from '@/frontend/utils/routeParams';
import { isIagentEdition } from '@/shared/utils/iagentEdition';

export default function SettingsStackLayout() {
  const [backgroundColor, foregroundColor] = useThemeColor(['background', 'foreground']);
  const isIagent = isIagentEdition();

  return (
    <NavRouteHeaderScope destination="settings">
      <DesktopPairingProvider>
        <Stack
          screenLayout={FormContentFrame}
          screenOptions={{
            ...headerScreenOptions,
            contentStyle: { backgroundColor },
            headerTransparent: false,
            headerTintColor: foregroundColor,
          }}
        >
          <Stack.Screen name="index" options={{ title: '' }} />
          <Stack.Protected guard={isIagent}>
            <Stack.Screen name="model-prices" />
          </Stack.Protected>
          <Stack.Protected guard={!isIagent}>
            <Stack.Screen
              name="about/feedback/[reportId]"
              getId={({ params }) => getSingleRouteParam(params?.reportId)}
            />
            <Stack.Screen name="about/feedback/index" />
            <Stack.Screen name="about/feedback/new" />
            <Stack.Screen name="about" />
            <Stack.Screen name="data" />
            <Stack.Screen name="data/deepseek" />
            <Stack.Screen name="device-connections/index" />
            <Stack.Screen name="device-connections/[connectionId]" />
            <Stack.Screen name="device-connections/pair" />
            <Stack.Screen name="device-connections/scan" />
            <Stack.Screen name="permissions/index" />
            <Stack.Screen name="permissions/[permission]" />
            <Stack.Screen name="privacy" />
            <Stack.Screen name="provider/desktop-sync" />
            <Stack.Screen name="voice" />
          </Stack.Protected>
        </Stack>
      </DesktopPairingProvider>
    </NavRouteHeaderScope>
  );
}
