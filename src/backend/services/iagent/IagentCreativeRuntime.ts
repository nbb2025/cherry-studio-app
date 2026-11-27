import { randomUUID } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { createMMKV } from 'react-native-mmkv';
import { z } from 'zod';

import { downloadFile } from '@/backend/services/download/downloadFile';
import { createHttpClient } from '@/backend/services/http';
import { IAGENT_ORIGIN, IagentError } from '@/shared/contracts/iagent';
import type {
  IagentCreativeModule,
  IagentMediaInput,
  IagentMediaTask,
} from '@/shared/contracts/iagentCreative';

import type { IagentAccountRuntime } from './IagentAccountRuntime';
import {
  creativeOutputFile,
  openMediaReference,
  saveVideoResponse,
  storeImageOutput,
  uploadTemporaryReference,
  uploadWanReference,
} from './iagentMediaFiles';
import {
  imageRequest,
  mediaStatusPath,
  publicMediaUrl,
  readMediaPayload,
  selectIagentMediaModels,
  validateIagentMediaInput,
  videoCreatePath,
  videoRequest,
} from './iagentMediaProtocol';
import type { IagentModelRuntime } from './IagentModelRuntime';

const MiB = 1024 * 1024;
const POLL_INTERVAL_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const IMAGE_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif', 'svg']);
const transport = createHttpClient({
  baseUrl: IAGENT_ORIGIN,
  statusPolicy: 'all',
  timeoutMs: 15_000,
});
const taskSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['image', 'video']),
  protocol: z.enum([
    'openai-image',
    'gemini-image',
    'grok-image',
    'grok-video',
    'seedance',
    'bailian',
    'video-lt',
  ]),
  modelName: z.string(),
  keyId: z.number().int().positive(),
  groupId: z.number().int().positive(),
  prompt: z.string(),
  createdAt: z.number(),
  status: z.enum(['submitting', 'pending', 'completed', 'failed', 'unknown']),
  serverId: z.string().optional(),
  error: z.string().optional(),
  assets: z.array(z.string()),
  outputFormat: z.enum(['png', 'jpeg', 'webp', 'gif', 'svg']).optional(),
  retryAt: z.number().optional(),
});
type StoredTask = z.infer<typeof taskSchema>;

function taskView({
  id,
  kind,
  modelName,
  prompt,
  createdAt,
  status,
  serverId,
  assets,
  error,
  retryAt,
}: StoredTask): IagentMediaTask {
  return {
    id,
    kind,
    modelName,
    prompt,
    createdAt,
    status,
    serverId,
    outputs: assets.length,
    error,
    retryAt,
  };
}

function timeToRetry(retryAfter: string | undefined) {
  if (retryAfter) {
    const delay = Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(delay)) return Date.now() + Math.max(POLL_INTERVAL_MS, delay);
    if (Number.isFinite(date)) return Math.max(Date.now() + POLL_INTERVAL_MS, date);
  }
  return Date.now() + POLL_INTERVAL_MS;
}

function imageExtension(source: string, fallback = 'png') {
  const extension = new URL(source).pathname.split('.').at(-1)?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(extension) ? extension : fallback;
}

type Submission = {
  path: string;
  fallbackPath?: string;
  headers: Record<string, string>;
  body: FormData | Record<string, unknown>;
};

export class IagentCreativeRuntime implements IagentCreativeModule {
  private readonly stores = new Map<number, ReturnType<typeof createMMKV>>();
  private readonly submissions = new Set<string>();
  private readonly checks = new Map<string, Promise<IagentMediaTask>>();
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(
    private readonly account: IagentAccountRuntime,
    private readonly models: Pick<IagentModelRuntime, 'loadCatalog' | 'getMediaKey'>,
  ) {}

  readonly listModels = async (callerSignal?: AbortSignal) => {
    const stateSignal = this.account.catalogSignal;
    const signal = callerSignal ? AbortSignal.any([stateSignal, callerSignal]) : stateSignal;
    const { groups, catalog } = await this.models.loadCatalog(signal);
    return selectIagentMediaModels(groups, catalog);
  };

  readonly listTasks = (): IagentMediaTask[] => {
    const owner = this.account.getState().iagentUserId;
    if (!owner) return [];
    const store = this.store(owner);
    return store
      .getAllKeys()
      .flatMap((id) => {
        const task = this.read(owner, id);
        if (!task) return [];
        // A previous runtime may have sent the request before being stopped.
        // Mark it unknown and do not create a replacement remote task.
        if (task.status === 'submitting' && !this.submissions.has(id)) {
          task.status = 'unknown';
          this.write(owner, task);
        }
        return taskView(task);
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  readonly submit = async (input: IagentMediaInput): Promise<IagentMediaTask> => {
    const signal = this.account.signal;
    const owner = this.requireOwner();
    input = { ...input, prompt: input.prompt.trim() };
    validateIagentMediaInput(input);
    const model = input.model;
    const config =
      model.kind === 'image' || (model.protocol === 'bailian' && input.references.length)
        ? await this.account.requestPublic<{
            async_enabled?: boolean;
            aliyun_assets_enabled?: boolean;
            wan_reference_transfer_mode?: 'base64' | 'temporary' | 'aliyun';
          }>('/site-api/image-config', signal)
        : undefined;
    const references = input.references.map((reference) => openMediaReference(reference, model));
    signal.throwIfAborted();
    const { id: keyId, value: key } = await this.models.getMediaKey(model.groupId);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    let body: FormData | Record<string, unknown>;
    let path: string;
    let fallbackPath: string | undefined;

    if (model.kind === 'image') {
      const request = imageRequest(input, Boolean(references.length));
      const files = references.flatMap((reference) =>
        'file' in reference && reference.file ? [reference] : [],
      );
      if (files.length !== references.length) throw new IagentError('request');
      path = request.path;
      if (config?.async_enabled) {
        if (model.protocol === 'openai-image') {
          path = `${request.path}/async`;
          fallbackPath = request.path;
        } else {
          path = '/site-api/image-tasks';
          headers['X-Iagent-Image-Route'] = request.route;
        }
      }
      if (request.route === 'gemini') {
        if (!request.baseModel || !/^[\w.-]+$/.test(request.baseModel))
          throw new IagentError('request');
        if (config?.async_enabled) headers['X-Iagent-Image-Model'] = request.baseModel;
        headers['x-goog-api-key'] = key;
        body = {
          contents: [
            {
              parts: [
                { text: input.prompt },
                ...(await Promise.all(
                  files.map(async ({ file, mimeType }) => ({
                    inlineData: { mimeType, data: await file.base64() },
                  })),
                )),
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: request.imageConfig,
          },
        };
      } else if (files.length && model.protocol === 'openai-image') {
        const form = new FormData();
        for (const [field, value] of Object.entries(request.fields ?? {}))
          form.append(field, String(value));
        for (const { file } of files) form.append('image[]', file, file.name);
        body = form;
      } else if (files.length) {
        const { file, mimeType } = files[0];
        body = {
          ...request.fields,
          image: { image_url: `data:${mimeType};base64,${await file.base64()}` },
        };
      } else {
        body = request.fields ?? {};
      }
    } else {
      path = videoCreatePath(model.protocol);
      headers['X-Iagent-Video-Platform'] = model.protocol;
      const uploaded: string[] = [];
      let inlineBytes = 0;
      for (const reference of references) {
        signal.throwIfAborted();
        if ('url' in reference && reference.url) {
          uploaded.push(reference.url);
          continue;
        }
        if (!reference.file) throw new IagentError('request');
        if (model.protocol === 'video-lt' || reference.kind === 'file') {
          uploaded.push(
            await uploadTemporaryReference(
              this.account,
              reference,
              signal,
              model.protocol === 'video-lt' ? 'video-lt' : undefined,
            ),
          );
        } else if (model.protocol === 'bailian' && config?.aliyun_assets_enabled) {
          uploaded.push(await uploadWanReference(this.account, model, reference, signal));
        } else if (
          model.protocol === 'bailian' &&
          reference.kind !== 'image' &&
          config?.wan_reference_transfer_mode !== 'base64'
        ) {
          uploaded.push(await uploadTemporaryReference(this.account, reference, signal));
        } else {
          inlineBytes += 4 * Math.ceil(reference.file.size / 3);
          if (inlineBytes > 64 * MiB - 64 * 1024) throw new IagentError('request');
          uploaded.push(`data:${reference.mimeType};base64,${await reference.file.base64()}`);
        }
      }
      if (
        model.protocol === 'bailian' &&
        uploaded.some((url) => /^data:(video|audio)\//.test(url))
      ) {
        path = '/site-api/wan/videos/generations';
        headers['X-Iagent-Studio-Session'] = await this.account.getAccessToken(signal);
      }
      body = videoRequest(input, uploaded);
    }

    const submission = { path, fallbackPath, headers, body };
    let latest = await this.submitOne(owner, keyId, input, submission, signal);
    for (let index = 1; index < (input.count ?? 1); index++) {
      if (latest.status === 'failed' || latest.status === 'unknown') break;
      latest = await this.submitOne(owner, keyId, input, submission, signal);
    }
    return latest;
  };

  private async submitOne(
    owner: number,
    keyId: number,
    input: IagentMediaInput,
    submission: Submission,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { model } = input;
    const task: StoredTask = {
      id: randomUUID(),
      kind: model.kind,
      protocol: model.protocol,
      modelName: model.name,
      keyId,
      groupId: model.groupId,
      prompt: input.prompt,
      createdAt: Date.now(),
      status: 'submitting',
      assets: [],
      outputFormat: input.outputFormat,
    };
    this.submissions.add(task.id);
    try {
      this.write(owner, task);
      let result;
      try {
        const send = (path: string) =>
          transport.request<unknown>({
            method: 'POST',
            path,
            headers: { ...submission.headers, 'Accept-Language': this.account.locale },
            body: submission.body,
            signal,
            credentials: 'omit',
            redirect: 'error',
            timeoutMs: 120_000,
            maxResponseBytes: 48 * MiB,
          });
        result = await send(submission.path);
        if (
          submission.fallbackPath &&
          [404, 405, 501].includes(result.status) &&
          !readMediaPayload(task.protocol, result.data, task.outputFormat).id
        )
          result = await send(submission.fallbackPath);
      } catch {
        return this.finish(owner, task, { status: 'unknown' });
      }
      const parsed = readMediaPayload(task.protocol, result.data, task.outputFormat);
      if (RETRYABLE_STATUS.has(result.status) || result.status >= 500)
        return this.finish(owner, task, { status: 'unknown' });
      if (result.status < 200 || result.status >= 300 || parsed.failure)
        return this.finish(owner, task, { status: 'failed', error: parsed.message?.slice(0, 480) });
      if (parsed.id) {
        try {
          mediaStatusPath(task.protocol, parsed.id);
          task.serverId = parsed.id;
        } catch {
          return this.finish(owner, task, { status: 'unknown' });
        }
        // Store the admitted job before touching output files.
        this.finish(owner, task, {
          status: 'pending',
          retryAt: timeToRetry(result.headers['retry-after']),
        });
      }
      if (parsed.outputs.length && !parsed.running) {
        try {
          return await this.saveResults(owner, task, parsed.outputs, signal);
        } catch {
          return taskView(
            task.serverId
              ? { ...task, status: 'pending' }
              : this.write(owner, { ...task, status: 'unknown' }),
          );
        }
      }
      return task.serverId ? taskView(task) : this.finish(owner, task, { status: 'unknown' });
    } finally {
      this.submissions.delete(task.id);
    }
  }

  readonly check = (id: string): Promise<IagentMediaTask> => {
    const signal = this.account.signal;
    const owner = this.requireOwner();
    const key = `${owner}:${id}`;
    const pending = this.checks.get(key);
    if (pending) return pending;
    const request = this.poll(owner, id, signal).finally(() => {
      if (this.checks.get(key) === request) this.checks.delete(key);
    });
    this.checks.set(key, request);
    return request;
  };

  readonly output = async (
    id: string,
    index: number,
    options?: { download?: boolean },
  ): Promise<string> => {
    const owner = this.requireOwner();
    const task = this.read(owner, id);
    const source = task?.assets[index];
    if (!task || !source || task.status !== 'completed') throw new IagentError('request');
    const url = publicMediaUrl(source);
    if (!url) return creativeOutputFile(owner, source).uri;
    const protectedVideo =
      task.kind === 'video' &&
      new URL(url).origin === IAGENT_ORIGIN &&
      /\/content\/?$/.test(new URL(url).pathname);
    if (!options?.download && !protectedVideo) return url;

    const downloadId = `${owner}:${id}:${index}`;
    const previous = this.downloads.get(downloadId);
    if (previous) return previous;
    const signal = this.account.signal;
    const request = this.download(owner, task, index, url, protectedVideo, signal).finally(() => {
      if (this.downloads.get(downloadId) === request) this.downloads.delete(downloadId);
    });
    this.downloads.set(downloadId, request);
    return request;
  };

  private async poll(owner: number, id: string, signal: AbortSignal): Promise<IagentMediaTask> {
    const task = this.read(owner, id);
    if (!task) throw new IagentError('request');
    if (task.status !== 'pending' || !task.serverId || (task.retryAt ?? 0) > Date.now())
      return taskView(task);
    const { value: key } = await this.models.getMediaKey(task.groupId, task.keyId);
    const response = await transport.request<unknown>({
      method: 'GET',
      path: mediaStatusPath(task.protocol, task.serverId),
      headers: { Authorization: `Bearer ${key}`, 'Accept-Language': this.account.locale },
      signal,
      credentials: 'omit',
      redirect: 'error',
      maxResponseBytes: 48 * MiB,
    });
    signal.throwIfAborted();
    const parsed = readMediaPayload(task.protocol, response.data, task.outputFormat);
    if (RETRYABLE_STATUS.has(response.status))
      return this.finish(owner, task, { retryAt: timeToRetry(response.headers['retry-after']) });
    if (response.status < 200 || response.status >= 300 || parsed.failure)
      return this.finish(owner, task, { status: 'failed', error: parsed.message?.slice(0, 480) });
    if (parsed.id && parsed.id !== task.serverId)
      return this.finish(owner, task, { status: 'failed' });
    if (parsed.outputs.length && !parsed.running)
      return this.saveResults(owner, task, parsed.outputs, signal);
    if (parsed.done && task.protocol === 'grok-video')
      return this.saveResults(
        owner,
        task,
        [`${IAGENT_ORIGIN}/v1/videos/${encodeURIComponent(task.serverId)}/content`],
        signal,
      );
    if (parsed.done) return this.finish(owner, task, { status: 'failed' });
    return this.finish(owner, task, { retryAt: timeToRetry(response.headers['retry-after']) });
  }

  private async saveResults(
    owner: number,
    task: StoredTask,
    sources: string[],
    signal: AbortSignal,
  ) {
    const assets: string[] = [];
    for (const [index, source] of sources.entries()) {
      signal.throwIfAborted();
      const asset =
        task.kind === 'image'
          ? await storeImageOutput(owner, task.id, index, source)
          : publicMediaUrl(source);
      if (asset) assets.push(asset);
    }
    signal.throwIfAborted();
    return this.finish(owner, task, { status: assets.length ? 'completed' : 'failed', assets });
  }

  private async download(
    owner: number,
    task: StoredTask,
    index: number,
    url: string,
    protectedVideo: boolean,
    signal: AbortSignal,
  ) {
    const extension = task.kind === 'video' ? 'mp4' : imageExtension(url, task.outputFormat);
    const file = creativeOutputFile(owner, `${task.id}-${index}.${extension}`);
    if (!file.size) {
      if (!protectedVideo) {
        try {
          await downloadFile({
            url,
            signal,
            destination: file.uri,
            validation: 'caller',
            maxBytes: task.kind === 'video' ? 256 * MiB : 32 * MiB,
            timeoutMs: 120_000,
          });
        } catch (error) {
          if (task.kind !== 'video' || !task.serverId || signal.aborted) throw error;
        }
      }
      if (!file.size && task.kind === 'video' && task.serverId) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const { value: key } = await this.models.getMediaKey(task.groupId, task.keyId);
        const contentPath = `/v1/videos/${encodeURIComponent(task.serverId)}/content`;
        const relay = task.protocol !== 'grok-video';
        const response = await expoFetch(
          `${IAGENT_ORIGIN}${relay ? '/site-api/media/download' : contentPath}`,
          {
            method: relay ? 'POST' : 'GET',
            headers: {
              Authorization: `Bearer ${key}`,
              ...(relay ? { 'Content-Type': 'application/json' } : {}),
            },
            body: relay
              ? JSON.stringify({
                  task_id: task.serverId,
                  ...(task.protocol === 'bailian' || task.protocol === 'video-lt'
                    ? { protocol: task.protocol }
                    : {}),
                })
              : undefined,
            credentials: 'omit',
            redirect: 'error',
            signal: requestSignal,
          },
        );
        await saveVideoResponse(response, file, requestSignal);
      }
    }
    signal.throwIfAborted();
    if (!file.size) throw new IagentError('request');
    // Keep explicitly saved output available when its original URL expires.
    const current = this.read(owner, task.id);
    if (current?.assets[index] === url) {
      current.assets[index] = file.name;
      this.write(owner, current);
    }
    return file.uri;
  }

  private requireOwner(): number {
    const owner = this.account.getState().iagentUserId;
    if (!owner) throw new IagentError('session');
    return owner;
  }

  private store(owner: number) {
    let store = this.stores.get(owner);
    if (!store) {
      store = createMMKV({ id: `iagent-creative-v1-${owner}` });
      this.stores.set(owner, store);
    }
    return store;
  }

  private read(owner: number, id: string): StoredTask | undefined {
    const stored = this.store(owner).getString(id);
    if (!stored) return undefined;
    try {
      const task = taskSchema.safeParse(JSON.parse(stored));
      return task.success && task.data.id === id ? task.data : undefined;
    } catch {
      return undefined;
    }
  }

  private write(owner: number, task: StoredTask): StoredTask {
    this.store(owner).set(task.id, JSON.stringify(task));
    return task;
  }

  private finish(owner: number, task: StoredTask, updates: Partial<StoredTask>): IagentMediaTask {
    Object.assign(task, updates);
    this.write(owner, task);
    return taskView(task);
  }
}
