export type IagentMediaKind = 'image' | 'video';
export type IagentImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg';
export type IagentImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type IagentReferenceKind = 'image' | 'video' | 'audio' | 'file' | 'link';
export type IagentReferenceRole = 'first_frame' | 'last_frame' | 'reference_image';
export const IAGENT_WAN_MODES = [
  'text',
  'first-frame',
  'first-last-frame',
  'reference',
  'edit',
  'extend',
] as const;
export type IagentWanMode = (typeof IAGENT_WAN_MODES)[number];

export type IagentMediaProtocol =
  | 'openai-image'
  | 'gemini-image'
  | 'grok-image'
  | 'grok-video'
  | 'seedance'
  | 'bailian'
  | 'video-lt';

export type IagentMediaModel = {
  id: string;
  name: string;
  groupId: number;
  groupName: string;
  kind: IagentMediaKind;
  protocol: IagentMediaProtocol;
  ratios: readonly string[];
  resolutions: readonly string[];
  durations: readonly number[];
  defaultRatio: string;
  defaultResolution?: string;
  defaultDuration?: number;
  referenceMode: 'none' | 'image' | 'frames';
  referenceLimits?: Partial<Record<IagentReferenceKind, number>>;
  referenceRoles?: readonly IagentReferenceRole[];
  framesUseAdaptiveRatio?: boolean;
  requiresReference?: boolean;
  promptLimit?: number;
  outputFormats?: readonly IagentImageFormat[];
  customSize?: 'exact' | 'ratio';
  supportsQuality?: boolean;
  supportsComplexity?: boolean;
  supportsWatermark?: boolean;
};

export type IagentMediaReference = {
  uri: string;
  mimeType?: string;
  kind?: IagentReferenceKind;
  role?: IagentReferenceRole;
  duration?: number;
};

export type IagentMediaInput = {
  model: IagentMediaModel;
  prompt: string;
  ratio: string;
  resolution?: string;
  duration?: number;
  references: IagentMediaReference[];
  count?: number;
  size?: { width: number; height: number };
  quality?: IagentImageQuality;
  outputFormat?: IagentImageFormat;
  complexity?: IagentImageQuality;
  frameCount?: number;
  frameDurationMs?: number;
  wanMode?: IagentWanMode;
  audio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
};

export type IagentMediaStatus = 'submitting' | 'pending' | 'completed' | 'failed' | 'unknown';

export type IagentMediaTask = {
  id: string;
  kind: IagentMediaKind;
  modelName: string;
  prompt: string;
  createdAt: number;
  status: IagentMediaStatus;
  serverId?: string;
  outputs: number;
  error?: string;
  retryAt?: number;
};

export interface IagentCreativeModule {
  listModels(signal?: AbortSignal): Promise<IagentMediaModel[]>;
  listTasks(): IagentMediaTask[];
  submit(input: IagentMediaInput): Promise<IagentMediaTask>;
  check(id: string): Promise<IagentMediaTask>;
  output(id: string, index: number, options?: { download?: boolean }): Promise<string>;
}
