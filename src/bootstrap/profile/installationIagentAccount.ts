import * as SecureStore from 'expo-secure-store';

import {
  IagentAccountRuntime,
  parseIagentSession,
} from '@/backend/services/iagent/IagentAccountRuntime';
import { IagentClient } from '@/backend/services/iagent/IagentClient';

const STORAGE_KEY = 'iagent.session';
const STORAGE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let runtime: IagentAccountRuntime | undefined;

export function readIagentSession() {
  try {
    return parseIagentSession(SecureStore.getItem(STORAGE_KEY, STORAGE_OPTIONS));
  } catch {
    return null;
  }
}

export function installationIagentAccount(locale: () => string): IagentAccountRuntime {
  runtime ??= new IagentAccountRuntime({
    client: new IagentClient(),
    stored: readIagentSession(),
    save: (session) =>
      SecureStore.setItem(STORAGE_KEY, session ? JSON.stringify(session) : '', STORAGE_OPTIONS),
    locale,
  });
  return runtime;
}
