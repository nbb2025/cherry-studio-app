import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { createMMKV } from 'react-native-mmkv';

import { application } from '@/backend/core/application/Application';
import { ProfileRegistry, resetProfileCaches } from '@/backend/data/profile';
import { DEFAULT_DOCUMENT_PARSER_MODE } from '@/shared/contracts/fileAttachment';
import { type ActiveProfile, LOCAL_PROFILE, setActiveProfile } from '@/shared/data/activeProfile';
import { INHERITABLE_PREFERENCE_KEYS } from '@/shared/data/preference';
import { configureIagentEdition, isIagentEdition } from '@/shared/utils/iagentEdition';

import { setDiagnosticProfile } from '../runtime/diagnosticContext';
import { readIagentSession } from './installationIagentAccount';

let registry: ProfileRegistry | undefined;

/** Installation-owned; outlives every profile and runtime reload. */
export function installationProfiles(): ProfileRegistry {
  if (!registry) {
    const store = createMMKV({ id: 'cherry-installation-profiles' });
    registry = new ProfileRegistry(
      { read: () => store.getString('registry'), write: (value) => store.set('registry', value) },
      randomUUID,
      () => {
        const values = application
          .get('PreferenceService')
          .getMultipleRawCached(INHERITABLE_PREFERENCE_KEYS);
        // A new profile has its own model providers, so a provider-bound parser does not carry over.
        return values['file.document_parser.mode'] === 'deepseek'
          ? { ...values, 'file.document_parser.mode': DEFAULT_DOCUMENT_PARSER_MODE }
          : values;
      },
    );
  }
  return registry;
}

/** Runs from the entry point before any profile-owned store opens. */
export function selectActiveProfile(): void {
  configureIagentEdition(Constants.expoConfig?.extra?.edition === 'iagent');
  const store = createMMKV({ id: 'cherry-installation-profiles' });
  const profile = isIagentEdition() ? iagentProfile(store) : installationProfiles().getActive();
  if (store.getString('cache-owner') !== profile.id) {
    // An absent owner also clears caches left by an older installation. Publish ownership only
    // after cleanup succeeds; a failure must retry before the next profile can read old content.
    resetProfileCaches();
    store.set('cache-owner', profile.id);
  }
  setActiveProfile(profile);
  setDiagnosticProfile(profile);
}

function iagentProfile(store: ReturnType<typeof createMMKV>): ActiveProfile {
  // A preview installation may already store its workspace in the signed-in namespace.
  // Pin that namespace once so sign-in and sign-out leave local data in place.
  let id = store.getString('iagent-data-profile');
  if (!id) {
    const legacy = readIagentSession();
    id = legacy ? `iagent-${legacy.userId}` : 'local';
    store.set('iagent-data-profile', id);
  }
  const userId = Number(/^iagent-([1-9]\d*)$/.exec(id)?.[1]);
  return Number.isSafeInteger(userId) && userId > 0
    ? { id: `iagent-${userId}` as const, identity: null, address: null, iagentUserId: userId }
    : LOCAL_PROFILE;
}
