import { isUniqueModelId, parseUniqueModelId } from '@/shared/data/types/model';

import type { IagentCreativeModule } from './iagentCreative';

export const IAGENT_ORIGIN = 'https://ai.iagent.dev';
const PROVIDER_PREFIX = 'iagent-group-';

export function iagentProviderId(groupId: number): string {
  return `${PROVIDER_PREFIX}${groupId}`;
}

export function iagentGroupId(providerId: string): number | null {
  if (!providerId.startsWith(PROVIDER_PREFIX)) return null;
  const id = Number(providerId.slice(PROVIDER_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 && iagentProviderId(id) === providerId ? id : null;
}

export function isIagentModel(id: string | null | undefined): boolean {
  return Boolean(
    id && isUniqueModelId(id) && iagentGroupId(parseUniqueModelId(id).providerId) !== null,
  );
}

export type IagentUser = { id: number; username: string; email: string; balance: number };

export type IagentPriceField =
  | 'input'
  | 'output'
  | 'cacheWrite'
  | 'cacheWriteHour'
  | 'cacheRead'
  | 'imageInput'
  | 'imageOutput'
  | 'generation';

export type IagentPriceUnit = 'tokens' | 'imageTokens' | 'image' | 'second' | 'video' | 'request';

export type IagentModelQuote = {
  id: string;
  name: string;
  platform: string;
  rate: number;
  reference: boolean;
  prices: { field: IagentPriceField; unit: IagentPriceUnit; usd: number; detail?: string }[];
};

export type IagentPriceGroup = {
  id: number;
  name: string;
  rate: number;
  models: IagentModelQuote[];
};

export type IagentPublicSettings = {
  registration_enabled?: boolean;
  email_verify_enabled?: boolean;
  invitation_code_enabled?: boolean;
  login_agreement_enabled?: boolean;
  login_agreement_documents?: { id: string; title: string; content_md: string }[];
  turnstile_enabled?: boolean;
  tencent_captcha_enabled?: boolean;
  aliyun_captcha_enabled?: boolean;
};

export type IagentSignIn = {
  email: string;
  password: string;
  registration?: { verifyCode?: string; invitationCode?: string };
};

export type IagentErrorCode =
  | 'unavailable'
  | 'credentials'
  | 'session'
  | 'request'
  | 'challenge'
  | 'totp'
  | 'key';

export class IagentError extends Error {
  constructor(
    readonly code: IagentErrorCode,
    readonly status = 0,
  ) {
    super(`iAgent ${code}`);
    this.name = 'IagentError';
  }
}

export interface IagentModule {
  creative: IagentCreativeModule;
  getPublicSettings(signal?: AbortSignal): Promise<IagentPublicSettings>;
  sendVerificationCode(email: string): Promise<number>;
  authenticate(input: IagentSignIn): Promise<string | null>;
  confirmTwoFactor(ticket: string, code: string): Promise<void>;
  listModels(): Promise<number>;
  getModelPrices(signal?: AbortSignal): Promise<IagentPriceGroup[]>;
  getUser(signal?: AbortSignal): Promise<IagentUser>;
  getUsage(signal?: AbortSignal): Promise<{ totalRequests: number; totalCost: number }>;
}
