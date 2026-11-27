import type { Provider } from '@/shared/data/types/provider';
import { isPresetProviderAvailable } from '@/shared/utils/iagentEdition';

export const PROVIDER_LIST_PAGE_SIZE = 20;
export const PROVIDER_LIST_STALE_TIME = 1000 * 60 * 5;

export function isVisibleSavedProvider(provider: Provider): boolean {
  return (
    !provider.presetProviderId ||
    isPresetProviderAvailable(provider.id) ||
    provider.id !== provider.presetProviderId ||
    provider.isEnabled ||
    provider.apiKeys.length > 0 ||
    provider.authType !== 'api-key' ||
    Object.keys(provider.settings).length > 0
  );
}
