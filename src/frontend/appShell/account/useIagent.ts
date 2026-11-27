import { useBackendModule } from '@/frontend/data';

export function useIagent() {
  const iagent = useBackendModule('iagent');
  if (!iagent) throw new Error('The iAgent module is unavailable');
  return iagent;
}
