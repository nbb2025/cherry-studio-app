import { Directory, File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';

import { IagentError } from '@/shared/contracts/iagent';
import type {
  IagentMediaModel,
  IagentMediaReference,
  IagentReferenceKind,
} from '@/shared/contracts/iagentCreative';

import type { IagentAccountRuntime } from './IagentAccountRuntime';
import { publicMediaUrl } from './iagentMediaProtocol';

const referenceMimeTypes: Record<Exclude<IagentReferenceKind, 'link'>, Record<string, string>> = {
  image: {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
  },
  video: { mp4: 'video/mp4', mov: 'video/quicktime' },
  audio: {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  },
  file: Object.fromEntries(
    [
      'docx',
      'doc',
      'xlsx',
      'xls',
      'pptx',
      'ppt',
      'pdf',
      'txt',
      'key',
      'pages',
      'numbers',
      'md',
    ].map((extension) => [extension, 'application/octet-stream']),
  ),
};
const SUPPORTED_OUTPUT = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
const OSS_FIELDS = [
  'OSSAccessKeyId',
  'Signature',
  'policy',
  'x-oss-object-acl',
  'x-oss-forbid-overwrite',
  'key',
  'success_action_status',
];

export function openMediaReference(reference: IagentMediaReference, model: IagentMediaModel) {
  const kind = reference.kind ?? 'image';
  const duration = reference.duration;
  if (reference.uri.startsWith('https://')) {
    const url = publicMediaUrl(reference.uri);
    if (!url || model.kind !== 'video') throw new IagentError('request');
    return { kind, duration, url } as const;
  }
  if (kind === 'link' || !reference.uri.startsWith('file:///')) throw new IagentError('request');
  const file = new File(reference.uri);
  const extension = file.extension.replace(/^\./, '').toLowerCase();
  const videoLT = model.protocol === 'video-lt';
  const mimeType = referenceMimeTypes[kind][extension];
  const maxBytes = {
    image: videoLT && !model.requiresReference ? 30_000_000 : 20_000_000,
    video: videoLT ? 200_000_000 : 100_000_000,
    audio: 15_000_000,
    file: 100_000_000,
  }[kind];
  if (
    !file.size ||
    file.size > maxBytes ||
    !mimeType ||
    (kind === 'image' &&
      ((extension === 'gif' && !videoLT) ||
        (extension === 'bmp' && model.protocol !== 'bailian'))) ||
    (kind === 'audio' && !videoLT && !['mp3', 'wav'].includes(extension))
  )
    throw new IagentError('request');
  return { file, mimeType, kind, duration } as const;
}

export function creativeOutputFile(userId: number, name: string): File {
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new IagentError('request');
  return new File(new Directory(Paths.document, 'iAgentCreative', String(userId)), name);
}

export async function storeImageOutput(
  userId: number,
  taskId: string,
  index: number,
  value: string,
) {
  const direct = publicMediaUrl(value);
  if (direct) return direct;
  const match = SUPPORTED_OUTPUT.exec(value);
  if (!match || match[2].length > 48 * 1024 * 1024) return undefined;
  const name = `${taskId}-${index}.${match[1] === 'jpeg' ? 'jpg' : match[1] === 'svg+xml' ? 'svg' : match[1]}`;
  const file = creativeOutputFile(userId, name);
  file.parentDirectory.create({ intermediates: true, idempotent: true });
  await file.write(match[2], { encoding: 'base64' });
  return name;
}

export async function uploadTemporaryReference(
  account: IagentAccountRuntime,
  {
    file,
    mimeType,
    kind,
    duration,
  }: Extract<ReturnType<typeof openMediaReference>, { file: File }>,
  signal: AbortSignal,
  profile?: 'video-lt',
) {
  const ticket = await account.request<{
    id: string;
    upload_url: string;
    headers?: Record<string, string>;
  }>('/site-api/media/upload-url', {
    body: {
      kind,
      name: file.name,
      size: file.size,
      ...(duration === undefined ? {} : { duration }),
      ...(profile ? { profile } : {}),
    },
    signal,
  });
  const target = publicMediaUrl(ticket.upload_url);
  if (!target || !/^[\w-]+$/.test(ticket.id)) throw new IagentError('request');
  const uploaded = await expoFetch(target, {
    method: 'PUT',
    body: file,
    signal: AbortSignal.any([signal, AbortSignal.timeout(profile ? 900_000 : 240_000)]),
    headers: {
      'Content-Type': ticket.headers?.['Content-Type'] ?? mimeType,
      'Cache-Control': 'no-store',
      ...(ticket.headers?.['If-None-Match']
        ? { 'If-None-Match': ticket.headers['If-None-Match'] }
        : {}),
    },
    credentials: 'omit',
    redirect: 'error',
  });
  if (!uploaded.ok) throw new IagentError('request', uploaded.status);
  const completion = await account.request<{ url: string; expires_at: number }>(
    `/site-api/media/uploads/${encodeURIComponent(ticket.id)}/complete`,
    { body: {}, signal },
  );
  const url = publicMediaUrl(completion.url);
  if (!url || completion.expires_at <= Date.now()) throw new IagentError('request');
  return url;
}

export async function uploadWanReference(
  account: IagentAccountRuntime,
  model: IagentMediaModel,
  { file, kind, duration }: Extract<ReturnType<typeof openMediaReference>, { file: File }>,
  signal: AbortSignal,
) {
  const ticket = await account.request<{
    upload_url: string;
    url: string;
    model: string;
    fields: Record<string, string>;
    expires_at: number;
  }>('/site-api/media/aliyun/upload-url', {
    body: {
      name: file.name,
      model: model.id,
      size: file.size,
      kind,
      ...(duration === undefined ? {} : { duration }),
    },
    signal,
  });
  const destination = new URL(ticket.upload_url);
  const object = new URL(ticket.url);
  if (
    destination.protocol !== 'https:' ||
    !destination.hostname.endsWith('.aliyuncs.com') ||
    destination.username ||
    destination.password ||
    destination.port ||
    destination.search ||
    destination.hash ||
    object.protocol !== 'oss:' ||
    !object.hostname ||
    object.username ||
    object.password ||
    object.search ||
    object.hash ||
    ticket.model !== model.id ||
    ticket.expires_at <= Date.now() ||
    ticket.fields?.key !== object.hostname + object.pathname
  )
    throw new IagentError('request');
  const body = new FormData();
  for (const field of OSS_FIELDS) {
    const value = ticket.fields[field];
    if (typeof value !== 'string') throw new IagentError('request');
    body.append(field, value);
  }
  body.append('file', file, file.name);
  const response = await expoFetch(destination.href, {
    method: 'POST',
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new IagentError('request', response.status);
  return ticket.url;
}

export async function saveVideoResponse(
  response: Pick<Response, 'ok' | 'status' | 'headers' | 'body'>,
  file: File,
  signal: AbortSignal,
): Promise<void> {
  const maxBytes = 256 * 1024 * 1024;
  const mimeType = response.headers.get('Content-Type')?.split(';')[0].toLowerCase();
  if (
    !response.ok ||
    !response.body ||
    (!mimeType?.startsWith('video/') && mimeType !== 'application/octet-stream') ||
    Number(response.headers.get('Content-Length')) > maxBytes
  )
    throw new IagentError('request', response.status);
  const temporary = new File(file.parentDirectory, `${file.name}.part`);
  temporary.create({ intermediates: true, overwrite: true });
  const reader = response.body.getReader();
  const writer = temporary.writableStream().getWriter();
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new IagentError('request');
      await writer.write(chunk.value);
    }
    signal.throwIfAborted();
    if (!size) throw new IagentError('request');
    await writer.close();
    await temporary.move(file);
  } catch (error) {
    await writer.abort().catch(() => undefined);
    if (temporary.exists) temporary.delete();
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
