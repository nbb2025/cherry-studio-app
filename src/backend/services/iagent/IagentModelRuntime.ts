import { eq, inArray } from 'drizzle-orm';
import { fetch as expoFetch } from 'expo/fetch';
import { createMMKV } from 'react-native-mmkv';

import {
  AppStatePolicy,
  BaseService,
  DependsOn,
  Injectable,
  Phase,
  ServicePhase,
} from '@/backend/core/lifecycle';
import { publishDataApiChanges } from '@/backend/data/dataApiChanges';
import type { DbService } from '@/backend/data/db/DbService';
import { userModelTable, userProviderTable } from '@/backend/data/db/schemas';
import type { PreferenceService } from '@/backend/data/PreferenceService';
import { insertWithOrderKey } from '@/backend/data/services/utils/orderKey';
import {
  IAGENT_ORIGIN,
  IagentError,
  iagentGroupId,
  isIagentModel,
} from '@/shared/contracts/iagent';

import type { IagentAccountRuntime } from './IagentAccountRuntime';
import {
  IAGENT_CHAT_ENDPOINTS,
  type IagentCatalog,
  type IagentCatalogResponse,
  type IagentEndpoint,
  type IagentGroups,
  publicIagentGroups,
  selectIagentCatalog,
} from './iagentCatalog';
import {
  buildIagentPriceGroups,
  type IagentPricingCatalog,
  type IagentPricingChannels,
  type IagentPricingPlaza,
} from './iagentModelPricing';

const KEY_NAMES = { chat: '聊天', media: '创意工坊' } as const;
const LEGACY_CHAT_KEY_NAME = 'iAgent App';
const KEY_CACHE_TTL_MS = 60_000;
const PAGE_SIZE = 100;
type KeyPurpose = keyof typeof KEY_NAMES;

type ApiKey = {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: string;
  expires_at?: string | null;
  quota?: number;
  quota_used?: number;
};

type KeyRequest = { signal: AbortSignal; expiresAt: number; result: Promise<ApiKey> };

@Injectable('IagentModelRuntime')
@DependsOn(['DbService', 'PreferenceService'])
@ServicePhase(Phase.Gate)
@AppStatePolicy('not-applicable')
export class IagentModelRuntime extends BaseService {
  private account: IagentAccountRuntime | undefined;
  private readonly lifetime = new AbortController();
  private readonly keys = new Map<string, KeyRequest>();
  private bindings: ReturnType<typeof createMMKV> | undefined;
  private catalog: { signal: AbortSignal; result: Promise<number> } | undefined;

  constructor(
    private readonly db: DbService,
    private readonly preference: PreferenceService,
  ) {
    super();
  }

  configure(account: IagentAccountRuntime): void {
    this.account = account;
    this.registerDisposable(
      account.subscribe(() => {
        if (!account.getState().isSignedIn) this.keys.clear();
      }),
    );
  }

  readonly listModels = (): Promise<number> => {
    const account = this.getAccount();
    const signal = account.catalogSignal;
    if (this.catalog?.signal === signal) return this.catalog.result;
    const result = this.refreshCatalog(AbortSignal.any([signal, this.lifetime.signal])).finally(
      () => {
        if (this.catalog?.result === result) this.catalog = undefined;
      },
    );
    this.catalog = { result, signal };
    return result;
  };

  readonly getUsage = async (signal?: AbortSignal) => {
    const stats = await this.getAccount().request<{
      total_requests: number;
      total_actual_cost: number;
    }>('/api/v1/usage/dashboard/stats', { signal });
    if (!Number.isFinite(stats.total_requests) || !Number.isFinite(stats.total_actual_cost))
      throw new IagentError('request');
    return { totalRequests: stats.total_requests, totalCost: stats.total_actual_cost };
  };

  readonly getModelPrices = async (callerSignal?: AbortSignal) => {
    const account = this.getAccount();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      account.catalogSignal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const signedIn = account.getState().isSignedIn;
    const [catalog, groups, channels, plaza, userRates] = await Promise.all([
      account.requestPublic<IagentPricingCatalog>(
        '/site-api/models?include_group_pricing=1',
        signal,
      ),
      signedIn ? account.request<IagentGroups>('/api/v1/groups/available', { signal }) : undefined,
      account
        .requestPublic<IagentPricingChannels>('/site-api/channels', signal)
        .catch(() => undefined),
      signedIn
        ? account
            .request<IagentPricingPlaza>('/api/v1/model-plaza', { signal })
            .catch(() => undefined)
        : undefined,
      signedIn
        ? account
            .request<Record<string, number>>('/api/v1/groups/rates', { signal })
            .catch(() => undefined)
        : undefined,
    ]);
    signal.throwIfAborted();
    if (!Array.isArray(catalog?.models) || (signedIn && !Array.isArray(groups)))
      throw new IagentError('request');
    return buildIagentPriceGroups(
      groups ?? publicIagentGroups(catalog),
      catalog,
      Array.isArray(channels) ? channels : [],
      Array.isArray(plaza?.groups) ? plaza : undefined,
      userRates ?? {},
    );
  };

  createModelFetch(providerId: string, endpoint: IagentEndpoint, modelId: string): typeof fetch {
    const groupId = iagentGroupId(providerId);
    if (groupId === null) throw new IagentError('request');
    const account = this.getAccount();
    const accountSignal = account.signal;
    return async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (endpoint === 'anthropic-messages' && url.search === '?beta=true') url.search = '';
      if (
        url.origin !== IAGENT_ORIGIN ||
        url.username ||
        url.password ||
        url.pathname !== IAGENT_CHAT_ENDPOINTS[endpoint].path ||
        url.search ||
        url.hash ||
        request.method !== 'POST'
      )
        throw new IagentError('request');
      const body = await request.text();
      if ((JSON.parse(body) as { model?: unknown }).model !== modelId)
        throw new IagentError('request');
      const signal = AbortSignal.any([this.lifetime.signal, accountSignal, request.signal]);
      signal.throwIfAborted();
      const { key } = await this.getKey(account, groupId, 'chat');
      signal.throwIfAborted();
      const headers = new Headers({
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept-Language': account.locale,
      });
      if (endpoint === 'anthropic-messages') {
        headers.set('x-api-key', key);
        headers.set('anthropic-version', request.headers.get('anthropic-version') ?? '2023-06-01');
      }
      const response = await expoFetch(url.toString(), {
        method: 'POST',
        headers,
        body,
        signal,
        credentials: 'omit',
        redirect: 'error',
      });
      const cacheKey = this.keyCacheId(groupId, 'chat');
      if (response.status === 401 && this.keys.get(cacheKey)?.signal === accountSignal)
        this.keys.delete(cacheKey);
      // Expo's response carries the live SSE body used by both model clients.
      return response as unknown as Response;
    };
  }

  protected override async onStop(): Promise<void> {
    this.lifetime.abort();
    this.keys.clear();
    await this.catalog?.result.catch(() => undefined);
  }

  async loadCatalog(signal: AbortSignal): Promise<{
    groups: IagentGroups;
    catalog: IagentCatalogResponse;
  }> {
    const account = this.getAccount();
    const [groups, catalog] = await Promise.all([
      account.getState().isSignedIn
        ? account.request<IagentGroups>('/api/v1/groups/available', { signal })
        : undefined,
      account.requestPublic<IagentCatalogResponse>('/site-api/models', signal),
    ]);
    signal.throwIfAborted();
    if (!Array.isArray(catalog?.models) || (groups !== undefined && !Array.isArray(groups)))
      throw new IagentError('request');
    return { groups: groups ?? publicIagentGroups(catalog), catalog };
  }

  private getAccount(): IagentAccountRuntime {
    if (!this.account) throw new IagentError('session');
    return this.account;
  }

  private async refreshCatalog(signal: AbortSignal): Promise<number> {
    try {
      const { groups, catalog } = await this.loadCatalog(signal);
      const selected = selectIagentCatalog(groups, catalog);
      await this.writeCatalog(selected, signal);
      publishDataApiChanges(['/models', '/providers', '/providers/page']);
      const models = selected.flatMap((group) => group.models);
      const current = this.preference.readCached('agent.default_model_id');
      const defaultModelId = models.some((model) => model.id === current)
        ? current
        : (models[0]?.id ?? null);
      if ((!current || isIagentModel(current)) && current !== defaultModelId) {
        signal.throwIfAborted();
        await this.preference.set('agent.default_model_id', defaultModelId);
      }
      return models.length;
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof IagentError) ||
        !(error.code === 'unavailable' || error.status >= 500 || error.status === 429)
      )
        throw error;
      const existing = (
        await this.db
          .getDb()
          .select({
            providerId: userModelTable.providerId,
          })
          .from(userModelTable)
          .where(eq(userModelTable.isEnabled, true))
      ).filter(({ providerId }) => iagentGroupId(providerId) !== null).length;
      if (!existing) throw error;
      return existing;
    }
  }

  private async writeCatalog(catalog: IagentCatalog, signal: AbortSignal): Promise<void> {
    await this.db.withWriteTx(async (tx) => {
      signal.throwIfAborted();
      const previous = new Set(
        (await tx.select({ id: userProviderTable.providerId }).from(userProviderTable)).map(
          ({ id }) => id,
        ),
      );
      const managedProviderIds = [...previous].filter((id) => iagentGroupId(id) !== null);
      if (managedProviderIds.length) {
        await tx
          .update(userProviderTable)
          .set({ isEnabled: false })
          .where(inArray(userProviderTable.providerId, managedProviderIds));
        await tx
          .update(userModelTable)
          .set({ isEnabled: false, isHidden: true })
          .where(inArray(userModelTable.providerId, managedProviderIds));
      }
      for (const { providerId, models, ...group } of catalog) {
        signal.throwIfAborted();
        const values = { ...group, apiKeys: [], presetProviderId: null, isEnabled: true };
        if (previous.has(providerId))
          await tx
            .update(userProviderTable)
            .set(values)
            .where(eq(userProviderTable.providerId, providerId));
        else
          await insertWithOrderKey(
            tx,
            userProviderTable,
            { ...values, providerId },
            { pkColumn: userProviderTable.providerId },
          );
        const stored = new Set(
          (
            await tx
              .select({ id: userModelTable.id })
              .from(userModelTable)
              .where(eq(userModelTable.providerId, providerId))
          ).map(({ id }) => id),
        );
        for (const model of models) {
          if (stored.has(model.id))
            await tx.update(userModelTable).set(model).where(eq(userModelTable.id, model.id));
          else
            await insertWithOrderKey(tx, userModelTable, model, {
              pkColumn: userModelTable.id,
              scope: eq(userModelTable.providerId, providerId),
            });
        }
      }
      signal.throwIfAborted();
    });
  }

  async getMediaKey(groupId: number, keyId?: number): Promise<{ id: number; value: string }> {
    const key = await this.getKey(this.getAccount(), groupId, 'media', keyId);
    return { id: key.id, value: key.key };
  }

  private keyCacheId(groupId: number, purpose: KeyPurpose, keyId?: number): string {
    return JSON.stringify([groupId, purpose, keyId]);
  }

  private getKey(
    account: IagentAccountRuntime,
    groupId: number,
    purpose: KeyPurpose,
    keyId?: number,
  ): Promise<ApiKey> {
    const signal = account.signal;
    const cacheKey = this.keyCacheId(groupId, purpose, keyId);
    const current = this.keys.get(cacheKey);
    if (current?.signal === signal && current.expiresAt > Date.now()) return current.result;
    const result = this.provisionKey(account, groupId, purpose, keyId).catch((error: unknown) => {
      if (this.keys.get(cacheKey)?.result === result) this.keys.delete(cacheKey);
      throw error;
    });
    const entry = { signal, expiresAt: Infinity, result };
    this.keys.set(cacheKey, entry);
    void result.then(
      () => {
        entry.expiresAt = Date.now() + KEY_CACHE_TTL_MS;
      },
      () => {},
    );
    return result;
  }

  private async provisionKey(
    account: IagentAccountRuntime,
    groupId: number,
    purpose: KeyPurpose,
    keyId?: number,
  ): Promise<ApiKey> {
    const signal = AbortSignal.any([this.lifetime.signal, account.signal]);
    const owner = account.getState().iagentUserId;
    if (!owner) throw new IagentError('session');
    const name = KEY_NAMES[purpose];
    const bindingId = `${owner}:${groupId}:${purpose}`;
    const bindings = (this.bindings ??= createMMKV({ id: 'iagent-workspace-keys-v1' }));
    const binding = keyId === undefined ? bindings.getString(bindingId) : undefined;
    const wantedId = keyId ?? Number(binding);
    const candidates: ApiKey[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const result = await account.request<{
        items: ApiKey[];
        pages: number;
        total?: number;
        page_size?: number;
      }>(`/api/v1/keys?page=${page}&page_size=${PAGE_SIZE}&group_id=${groupId}`, { signal });
      if (!Array.isArray(result.items)) throw new IagentError('key');
      if (Number.isSafeInteger(result.pages)) pages = Math.max(pages, result.pages);
      const total = result.total ?? 0;
      if (Number.isSafeInteger(total) && total > 0) {
        const size = result.page_size && result.page_size > 0 ? result.page_size : PAGE_SIZE;
        pages = Math.max(pages, Math.ceil(total / size));
      }
      if ((page > 1 || pages > 1 || total > 0) && result.items.length === 0)
        throw new IagentError('key');
      candidates.push(
        ...result.items.filter((key) => {
          if (!Number.isSafeInteger(key.id) || key.id <= 0 || key.group_id !== groupId)
            return false;
          if (key.id === wantedId) return true;
          return (
            keyId === undefined &&
            (key.name === name || (purpose === 'chat' && key.name === LEGACY_CHAT_KEY_NAME))
          );
        }),
      );
    }
    signal.throwIfAborted();
    const priority = (key: ApiKey) => (key.id === wantedId ? 0 : key.name === name ? 1 : 2);
    candidates.sort((left, right) => priority(left) - priority(right) || left.id - right.id);
    const existing = candidates.find(isUsableKey);
    if (existing) {
      if (keyId === undefined) bindings.set(bindingId, String(existing.id));
      return existing;
    }
    if (keyId !== undefined) throw new IagentError('key');
    if (candidates.length) bindings.set(bindingId, String(candidates[0].id));
    if (binding || candidates.length) throw new IagentError('key');

    const groups = await account.request<IagentGroups>('/api/v1/groups/available', { signal });
    if (
      !Array.isArray(groups) ||
      !groups.some((group) => group.id === groupId && group.status === 'active')
    )
      throw new IagentError('key', 403);
    signal.throwIfAborted();
    // A lost create response is recovered by listing the group inventory on the next attempt.
    bindings.set(bindingId, 'pending');
    let key: ApiKey;
    try {
      key = await account.request<ApiKey>('/api/v1/keys', {
        body: { group_id: groupId, name },
        idempotencyKey: `iagent-workspace-v1-${owner}-${groupId}-${purpose}`,
        signal,
      });
    } catch (error) {
      if (
        !signal.aborted &&
        error instanceof IagentError &&
        [400, 401, 403, 404].includes(error.status)
      )
        bindings.remove(bindingId);
      throw error;
    }
    signal.throwIfAborted();
    if (key.group_id !== groupId || !Number.isSafeInteger(key.id) || key.id <= 0)
      throw new IagentError('key');
    bindings.set(bindingId, String(key.id));
    if (!isUsableKey(key)) throw new IagentError('key');
    return key;
  }
}

function isUsableKey(key: ApiKey): boolean {
  return (
    key.status === 'active' &&
    typeof key.key === 'string' &&
    key.key.length > 0 &&
    (!key.expires_at || Date.parse(key.expires_at) > Date.now()) &&
    (!(Number(key.quota) > 0) || Number(key.quota_used ?? 0) < Number(key.quota))
  );
}
