import type { AccountModule, AccountState } from '@/shared/contracts/account';
import {
  IagentError,
  type IagentPublicSettings,
  type IagentSignIn,
  type IagentUser,
} from '@/shared/contracts/iagent';

import type { IagentClient } from './IagentClient';

const TOKEN_REFRESH_SKEW_MS = 60_000;

export type IagentSession = {
  userId: number;
  name: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export function parseIagentSession(value: string | null): IagentSession | null {
  if (!value) return null;
  try {
    const session = JSON.parse(value) as Partial<IagentSession>;
    return isUserId(session.userId) &&
      typeof session.name === 'string' &&
      typeof session.accessToken === 'string' &&
      session.accessToken.length > 0 &&
      (session.refreshToken === undefined || typeof session.refreshToken === 'string') &&
      (session.expiresAt === undefined || Number.isFinite(session.expiresAt))
      ? (session as IagentSession)
      : null;
  } catch {
    return null;
  }
}

function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

type AuthResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  requires_2fa?: boolean;
  temp_token?: string;
  user?: IagentUser;
};

function decodeSession(response: AuthResponse, previous?: IagentSession): IagentSession {
  if (response.requires_2fa) throw new IagentError('challenge');
  const userId = response.user?.id ?? previous?.userId;
  if (
    !isUserId(userId) ||
    (previous && userId !== previous.userId) ||
    typeof response.access_token !== 'string' ||
    !response.access_token
  )
    throw new IagentError('request');
  const expiresIn = Number(response.expires_in);
  return {
    userId,
    name: response.user?.username || response.user?.email || previous?.name || '',
    accessToken: response.access_token,
    refreshToken: response.refresh_token || previous?.refreshToken,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

export type IagentAccountOptions = {
  client: IagentClient;
  stored: IagentSession | null;
  save(session: IagentSession | null): void;
  locale(): string;
};

export class IagentAccountRuntime implements AccountModule {
  private session: IagentSession | null;
  private lifetime = new AbortController();
  private refreshing: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private state: AccountState;

  constructor(private readonly options: IagentAccountOptions) {
    this.session = options.stored;
    this.state = {
      isSignedIn: this.session !== null,
      isEnterprise: false,
      isRestoringSession: false,
      isRestoringCommunitySession: false,
      needsSignIn: false,
      hasPrompted: true,
      isBusy: false,
      name: this.session?.name,
      iagentUserId: this.session?.userId,
    };
  }

  readonly getState = (): AccountState => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly signIn = async (): Promise<boolean> => false;
  readonly switchSpace = async (): Promise<boolean> => false;
  readonly receiveRedirect = async (): Promise<boolean> => false;
  readonly dismissPrompt = (): void => {};

  readonly getPublicSettings = (signal?: AbortSignal) =>
    this.options.client.request<IagentPublicSettings>('/api/v1/settings/public', {
      locale: this.options.locale(),
      signal,
    });

  readonly sendVerificationCode = async (email: string): Promise<number> => {
    const result = await this.options.client.request<{ countdown?: number }>(
      '/api/v1/auth/send-verify-code',
      {
        body: { email },
        locale: this.options.locale(),
      },
    );
    return result.countdown && result.countdown > 0 ? result.countdown : 60;
  };

  readonly authenticate = async ({
    email,
    password,
    registration,
  }: IagentSignIn): Promise<string | null> => {
    if (this.state.isBusy || this.state.isSignedIn) throw new IagentError('request');
    this.update({ isBusy: true });
    try {
      const response = await this.options.client.request<AuthResponse>(
        registration ? '/api/v1/auth/register' : '/api/v1/auth/login',
        {
          locale: this.options.locale(),
          body: {
            email,
            password,
            verify_code: registration?.verifyCode,
            invitation_code: registration?.invitationCode,
          },
        },
      );
      if (response.requires_2fa) {
        if (typeof response.temp_token !== 'string' || !response.temp_token.trim())
          throw new IagentError('challenge');
        return response.temp_token;
      }
      this.completeLogin(response);
      return null;
    } catch (error) {
      if (!registration && error instanceof IagentError && error.status === 401)
        throw new IagentError('credentials', error.status);
      throw error;
    } finally {
      this.update({ isBusy: false });
    }
  };

  readonly confirmTwoFactor = async (ticket: string, code: string): Promise<void> => {
    if (this.state.isBusy || this.state.isSignedIn || !ticket || !/^\d{6}$/.test(code))
      throw new IagentError('totp');
    this.update({ isBusy: true });
    try {
      this.completeLogin(
        await this.options.client.request<AuthResponse>('/api/v1/auth/login/2fa', {
          locale: this.options.locale(),
          body: { temp_token: ticket, totp_code: code },
        }),
      );
    } catch (error) {
      if (error instanceof IagentError && [400, 401, 403, 429].includes(error.status))
        throw new IagentError('totp', error.status);
      throw error;
    } finally {
      this.update({ isBusy: false });
    }
  };

  private completeLogin(response: AuthResponse): void {
    const session = decodeSession(response);
    this.options.save(session);
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.session = session;
    this.update({ isSignedIn: true, name: session.name, iagentUserId: session.userId });
  }

  readonly signOut = async (): Promise<void> => {
    if (this.state.isBusy || !this.session) return;
    this.update({ isBusy: true });
    const session = this.session;
    try {
      this.revoke();
      await this.options.client
        .request('/api/v1/auth/logout', {
          body: { refresh_token: session.refreshToken },
          token: session.accessToken,
          locale: this.options.locale(),
        })
        .catch(() => undefined);
    } finally {
      this.update({ isBusy: false });
    }
  };

  readonly getUser = async (signal?: AbortSignal): Promise<IagentUser> => {
    const user = await this.request<IagentUser>('/api/v1/auth/me', { signal });
    if (user.id !== this.session?.userId) throw new IagentError('session');
    return user;
  };

  get catalogSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  get signal(): AbortSignal {
    if (!this.session) throw new IagentError('session');
    return this.lifetime.signal;
  }

  readonly requestPublic = <T>(path: string, signal?: AbortSignal): Promise<T> =>
    this.options.client.request<T>(path, { signal, locale: this.locale });

  get locale(): string {
    return this.options.locale();
  }

  async getAccessToken(signal: AbortSignal): Promise<string> {
    if (
      this.session?.refreshToken &&
      this.session.expiresAt &&
      this.session.expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS
    ) {
      try {
        await this.refresh(this.session.accessToken);
      } catch (error) {
        if (!this.session?.expiresAt || this.session.expiresAt <= Date.now()) throw error;
      }
    }
    signal.throwIfAborted();
    const token = this.session?.accessToken;
    if (!token) throw new IagentError('session');
    return token;
  }

  async request<T>(
    path: string,
    options: {
      signal?: AbortSignal;
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    const token = await this.getAccessToken(signal);
    const send = (accessToken: string) =>
      this.options.client.request<T>(path, {
        ...options,
        token: accessToken,
        locale: this.options.locale(),
        signal,
      });
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof IagentError) || error.status !== 401) throw error;
      signal.throwIfAborted();
      await this.refresh(token);
      signal.throwIfAborted();
      if (!this.session) throw new IagentError('session');
      try {
        return await send(this.session.accessToken);
      } catch (retryError) {
        if (!signal.aborted && retryError instanceof IagentError && retryError.status === 401)
          this.revoke();
        throw retryError;
      }
    }
  }

  private async refresh(rejected: string): Promise<void> {
    const session = this.session;
    if (!session) throw new IagentError('session');
    if (session.accessToken !== rejected) return;
    if (!this.refreshing) {
      const pending = this.rotate(session).finally(() => {
        if (this.refreshing === pending) this.refreshing = undefined;
      });
      this.refreshing = pending;
    }
    return this.refreshing;
  }

  private async rotate(session: IagentSession): Promise<void> {
    const signal = this.signal;
    try {
      if (!session.refreshToken) throw new IagentError('session', 401);
      const response = await this.options.client.request<AuthResponse>('/api/v1/auth/refresh', {
        body: { refresh_token: session.refreshToken },
        locale: this.options.locale(),
        signal,
      });
      signal.throwIfAborted();
      const next = decodeSession(response, session);
      this.options.save(next);
      this.session = next;
    } catch (error) {
      if (!signal.aborted && error instanceof IagentError && [401, 403].includes(error.status))
        this.revoke();
      throw error;
    }
  }

  private revoke(): void {
    this.options.save(null);
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.refreshing = undefined;
    this.session = null;
    this.update({ isSignedIn: false, name: undefined, iagentUserId: undefined });
  }

  private update(changes: Partial<AccountState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of [...this.listeners]) listener();
  }
}
