import { createHttpClient, type HttpRequest, type HttpResponse } from '@/backend/services/http';
import { IAGENT_ORIGIN, IagentError } from '@/shared/contracts/iagent';

const transport = createHttpClient({
  baseUrl: IAGENT_ORIGIN,
  serviceName: 'iAgent',
  statusPolicy: 'all',
  timeoutMs: 15_000,
});

type RequestOptions = {
  body?: Record<string, unknown>;
  token?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  locale: string;
};

export class IagentClient {
  constructor(
    private readonly send: (
      request: HttpRequest,
    ) => Promise<HttpResponse<unknown>> = transport.request,
  ) {}

  async request<T>(
    path: string,
    { body, token, idempotencyKey, signal, locale }: RequestOptions,
  ): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new IagentError('request');
    let response: HttpResponse<unknown>;
    try {
      response = await this.send({
        ...(body ? { method: 'POST', body } : { method: 'GET' }),
        path,
        headers: {
          Accept: 'application/json',
          'Accept-Language': locale,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        credentials: 'omit',
        redirect: 'error',
        maxResponseBytes: 4 * 1024 * 1024,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new IagentError('unavailable');
    }
    const result = response.data as {
      code?: string | number;
      data?: T;
    } | null;
    signal?.throwIfAborted();
    const code = String(result?.code ?? '').toLowerCase();
    if (
      response.status === 401 ||
      ['401', 'unauthorized', 'token_expired', 'invalid_token'].includes(code)
    )
      throw new IagentError('session', 401);
    if (response.status < 200 || response.status >= 300 || !result || typeof result !== 'object')
      throw new IagentError('request', response.status);
    if ('code' in result) {
      if (Number(result.code) !== 0 || result.data === undefined)
        throw new IagentError('request', response.status);
      return result.data;
    }
    return result as T;
  }
}
