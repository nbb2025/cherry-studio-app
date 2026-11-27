let iagentEdition = false;

/** Bootstrap sets the installation edition before opening profile-owned stores. */
export function configureIagentEdition(enabled: boolean): void {
  iagentEdition = enabled;
}

export function isIagentEdition(): boolean {
  return iagentEdition;
}

export function isPresetProviderAvailable(providerId: string): boolean {
  return !isIagentEdition() || providerId === 'deepseek';
}
