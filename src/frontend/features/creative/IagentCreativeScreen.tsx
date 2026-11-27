import SparklesIcon from '@cherrystudio/app-icons/icons/sparkles';
import {
  Button,
  ContentState,
  Image,
  Input,
  OptionPickerBottomSheet,
  type OptionPickerOption,
  Section,
  SelectField,
  Switch,
  Tabs,
  TextField,
  useToast,
} from '@cherrystudio/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsFocused, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccount, useIagent } from '@/frontend/appShell/account';
import { RouteHeader } from '@/frontend/appShell/header';
import { IagentError } from '@/shared/contracts/iagent';
import {
  IAGENT_WAN_MODES,
  type IagentImageFormat,
  type IagentImageQuality,
  type IagentMediaKind,
  type IagentMediaModel,
  type IagentMediaTask,
  type IagentWanMode,
} from '@/shared/contracts/iagentCreative';
import { wanDurationChoices } from '@/shared/utils/iagentVideoOptions';

import { IagentCreativeReferences, type CreativeReference } from './IagentCreativeReferences';

const MEDIA_KINDS = ['image', 'video'] as const;
const kindLabels = { image: 'iagent.studio.image', video: 'iagent.studio.video' } as const;
const qualityLabels = {
  auto: 'painting.settings.option.auto',
  low: 'painting.settings.option.low',
  medium: 'painting.settings.option.medium',
  high: 'painting.settings.option.high',
} as const;
const wanModeLabels = {
  text: 'iagent.studio.modeText',
  'first-frame': 'iagent.studio.modeFirst',
  'first-last-frame': 'iagent.studio.modeFrames',
  reference: 'iagent.studio.modeReference',
  edit: 'iagent.studio.modeEdit',
  extend: 'iagent.studio.modeExtend',
} as const satisfies Record<IagentWanMode, string>;
const POLL_INTERVAL_MS = 5_000;
const modelKey = (model: IagentMediaModel) => `${model.groupId}:${model.id}`;
type Field =
  | 'model'
  | 'ratio'
  | 'resolution'
  | 'duration'
  | 'outputFormat'
  | 'quality'
  | 'complexity'
  | 'wanMode'
  | 'referenceMode';
type NumericField = 'count' | 'width' | 'height' | 'frameCount' | 'frameDurationMs' | 'seed';

type Draft = {
  prompt: string;
  model?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  references: CreativeReference[];
  outputFormat?: IagentImageFormat;
  quality?: IagentImageQuality;
  complexity?: IagentImageQuality;
  wanMode?: IagentWanMode;
  referenceMode?: 'frames' | 'reference';
  audio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
} & Partial<Record<NumericField, string>>;
const emptyDraft: Draft = { prompt: '', references: [] };

export function IagentCreativeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const focused = useIsFocused();
  const { bottom } = useSafeAreaInsets();
  const { account, state } = useAccount();
  const { creative } = useIagent();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<IagentMediaKind>('image');
  const [drafts, setDrafts] = useState<Record<IagentMediaKind, Draft>>({
    image: emptyDraft,
    video: emptyDraft,
  });
  const [field, setField] = useState<Field>();
  const [taskId, setTaskId] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const busy = useRef(false);

  const draft = drafts[kind];
  const updateDraft = (patch: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [kind]: { ...previous[kind], ...patch } }));
  const catalog = useQuery({
    queryKey: ['iagent', 'creative-models', state.iagentUserId],
    queryFn: ({ signal }) => creative.listModels(signal),
    refetchOnWindowFocus: 'always',
    refetchInterval: focused && state.isSignedIn ? 60_000 : false,
    retry: false,
  });
  const models = (catalog.data ?? []).filter((model) => model.kind === kind);
  const model = models.find((item) => modelKey(item) === draft.model) ?? models[0];
  const image = kind === 'image';
  const wan = model?.protocol === 'bailian';
  const wanMode = draft.wanMode ?? 'text';
  const referenceMode =
    draft.referenceMode ??
    (model?.referenceRoles?.includes('first_frame') ? 'frames' : 'reference');
  const outputFormat = model?.outputFormats?.includes(draft.outputFormat ?? 'png')
    ? (draft.outputFormat ?? 'png')
    : 'png';
  const gif = outputFormat === 'gif';
  const vectors = outputFormat === 'svg';
  const customSize = Boolean(model?.customSize && draft.ratio === 'custom');
  const references = !vectors && (!wan || wanMode !== 'text') ? draft.references : [];
  const frameSlots = wan
    ? wanMode === 'first-frame'
      ? (['first_frame'] as const)
      : wanMode === 'first-last-frame'
        ? (['first_frame', 'last_frame'] as const)
        : undefined
    : !image && referenceMode === 'frames' && model?.referenceRoles?.includes('first_frame')
      ? (['first_frame', 'last_frame'] as const)
      : undefined;
  const adaptive =
    model?.framesUseAdaptiveRatio && references.some((item) => item.role === 'first_frame');
  const ratio =
    adaptive && model?.ratios.includes('adaptive')
      ? 'adaptive'
      : !customSize && !gif && model?.ratios.includes(draft.ratio ?? '')
        ? draft.ratio
        : model?.defaultRatio;
  const resolution =
    gif || customSize
      ? undefined
      : model?.resolutions.includes(draft.resolution ?? '')
        ? draft.resolution
        : model?.defaultResolution;
  const durations = wan ? wanDurationChoices(references) : (model?.durations ?? []);
  const duration = durations.includes(draft.duration ?? 0)
    ? draft.duration
    : durations.includes(model?.defaultDuration ?? 0)
      ? model?.defaultDuration
      : durations[0];
  const requiresPrompt = !wan || wanMode === 'text' || wanMode === 'edit' || wanMode === 'extend';
  const hasInput = Boolean(draft.prompt.trim()) || (!requiresPrompt && Boolean(references.length));
  const linkOrFile = references.some((item) => item.kind === 'file' || item.kind === 'link');
  const editingVideo = wan && (wanMode === 'edit' || wanMode === 'extend');
  const referenceModel = editingVideo
    ? { ...model!, referenceLimits: { ...model?.referenceLimits, file: 0, link: 0 } }
    : model;

  const tasksKey = ['iagent', 'creative-tasks', state.iagentUserId] as const;
  const history = useQuery({
    queryKey: tasksKey,
    queryFn: () => creative.listTasks(),
    enabled: state.isSignedIn,
  });
  const tasks = (history.data ?? []).filter((task) => task.kind === kind);
  const selected = tasks.find((task) => task.id === taskId) ?? tasks[0];
  const status = useQuery({
    queryKey: ['iagent', 'creative-task', state.iagentUserId, selected?.id],
    queryFn: async () => {
      const result = await creative.check(selected!.id);
      if (account.getState().iagentUserId === state.iagentUserId)
        queryClient.setQueryData(tasksKey, creative.listTasks());
      return result;
    },
    enabled: focused && state.isSignedIn && selected?.status === 'pending',
    refetchInterval: (query) =>
      query.state.status === 'error' || query.state.dataUpdateCount >= 180
        ? false
        : POLL_INTERVAL_MS,
    retry: false,
  });

  const generate = async () => {
    if (busy.current || !model || !ratio || !hasInput) return;
    Keyboard.dismiss();
    if (!state.isSignedIn) {
      router.navigate('/login');
      return;
    }
    if (model.requiresReference && !references.length) {
      toast.show({ label: t('painting.input.referenceRequired'), variant: 'danger' });
      return;
    }
    busy.current = true;
    setPreparing(true);
    try {
      const result = await creative.submit({
        model,
        ratio,
        resolution,
        duration,
        references,
        prompt: draft.prompt,
        count: vectors ? 1 : Number(draft.count ?? '1'),
        ...(image
          ? {
              outputFormat,
              ...(model.supportsQuality ? { quality: draft.quality ?? 'high' } : {}),
              ...(model.supportsComplexity ? { complexity: draft.complexity ?? 'auto' } : {}),
              ...(customSize
                ? { size: { width: Number(draft.width), height: Number(draft.height) } }
                : {}),
              ...(gif
                ? {
                    frameCount: Number(draft.frameCount ?? '9'),
                    frameDurationMs: Number(draft.frameDurationMs ?? '200'),
                  }
                : {}),
            }
          : {}),
        ...(wan
          ? {
              wanMode,
              audio: draft.audio ?? true,
              promptExtend: linkOrFile || (draft.promptExtend ?? true),
              ...(draft.seed?.trim() ? { seed: Number(draft.seed) } : {}),
            }
          : {}),
        ...(model.supportsWatermark ? { watermark: draft.watermark ?? false } : {}),
      });
      if (account.getState().iagentUserId === state.iagentUserId) {
        await queryClient.invalidateQueries({ queryKey: tasksKey, exact: true });
        setTaskId(result.id);
      }
    } catch (error) {
      if (error instanceof IagentError && error.code === 'session') router.navigate('/login');
      else toast.show({ label: t('iagent.studio.submitFailed'), variant: 'danger' });
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  };

  const auto = t('painting.settings.option.auto');
  const formatRatio = (value: string) => (['auto', 'adaptive'].includes(value) ? auto : value);
  const formatDuration = (value: number) =>
    value === -1 ? auto : t('iagent.studio.seconds', { seconds: value });
  const fieldLabels = {
    model: t('iagent.studio.model'),
    ratio: t('painting.settings.param.aspectRatio'),
    resolution: t('painting.settings.param.resolution'),
    duration: t('iagent.studio.duration'),
    outputFormat: t('painting.settings.param.outputFormat'),
    quality: t('painting.settings.param.quality'),
    complexity: t('painting.settings.param.complexity'),
    wanMode: t('iagent.studio.generationMode'),
    referenceMode: t('painting.settings.param.refMode'),
  };
  const qualities = Object.entries(qualityLabels).map(([value, label]) => ({
    value,
    label: t(label),
  }));
  const optionLists: Record<Field, readonly OptionPickerOption<string>[]> = {
    model: models.map((item) => ({
      value: modelKey(item),
      label: item.name,
      description: item.groupName,
    })),
    ratio: [
      ...(gif ? ['auto'] : (model?.ratios ?? [])).map((value) => ({
        value,
        label: formatRatio(value),
      })),
      ...(model?.customSize
        ? [{ value: 'custom', label: t('painting.settings.param.customSize') }]
        : []),
    ],
    resolution: (model?.resolutions ?? []).map((value) => ({
      value,
      label: value === 'auto' ? auto : value,
    })),
    duration: durations.map((value) => ({ value: String(value), label: formatDuration(value) })),
    outputFormat: (model?.outputFormats ?? [])
      .filter((value) => value !== 'svg' || !references.length)
      .map((value) => ({ value, label: value.toUpperCase() })),
    quality: qualities,
    complexity: qualities,
    wanMode: IAGENT_WAN_MODES.map((value) => ({ value, label: t(wanModeLabels[value]) })),
    referenceMode: [
      { value: 'frames', label: t(wanModeLabels['first-last-frame']) },
      { value: 'reference', label: t(wanModeLabels.reference) },
    ],
  };
  const fieldValues = {
    model: model ? modelKey(model) : '',
    ratio: customSize ? 'custom' : (ratio ?? ''),
    resolution: resolution ?? 'auto',
    duration: duration === undefined ? '' : String(duration),
    outputFormat,
    quality: draft.quality ?? 'high',
    complexity: draft.complexity ?? 'auto',
    wanMode,
    referenceMode,
  };
  const select = (value: string) => {
    if (field === 'model') {
      setDrafts((previous) => ({
        ...previous,
        [kind]: { ...emptyDraft, prompt: draft.prompt, model: value },
      }));
    } else if (field === 'duration') {
      updateDraft({ duration: Number(value) });
    } else if (field === 'outputFormat') {
      updateDraft({
        outputFormat: value as IagentImageFormat,
        ratio: undefined,
        resolution: undefined,
      });
    } else if (field === 'wanMode') {
      updateDraft({ wanMode: value as IagentWanMode, references: [] });
    } else if (field === 'referenceMode') {
      updateDraft({ referenceMode: value as Draft['referenceMode'], references: [] });
    } else if (field === 'ratio' && value === 'custom') {
      updateDraft({ ratio: value, width: draft.width ?? '1024', height: draft.height ?? '1024' });
    } else if (field) {
      updateDraft({ [field]: value });
    }
  };

  const renderField = (name: Field) => {
    const value = optionLists[name].find((option) => option.value === fieldValues[name])?.label;
    return (
      <SelectField
        key={name}
        accessibilityLabel={fieldLabels[name]}
        disabled={preparing || optionLists[name].length < 2 || (name === 'ratio' && adaptive)}
        onPress={() => setField(name)}
        testID={`iagent-studio-${name}`}
      >
        <SelectField.Label>{fieldLabels[name]}</SelectField.Label>
        <SelectField.Value>
          <SelectField.ValueText>{value ?? auto}</SelectField.ValueText>
        </SelectField.Value>
      </SelectField>
    );
  };

  const renderNumber = (name: NumericField, label: string, fallback: string) => (
    <TextField key={name}>
      <TextField.Label>{label}</TextField.Label>
      <Input
        accessibilityLabel={label}
        disabled={preparing}
        keyboardType={name === 'seed' ? 'numbers-and-punctuation' : 'number-pad'}
        onChangeText={(value) => updateDraft({ [name]: value })}
        placeholder={fallback}
        testID={`iagent-studio-${name}`}
        value={draft[name] ?? fallback}
      />
    </TextField>
  );
  const toggles = wan
    ? ([
        {
          name: 'audio',
          label: t('iagent.studio.audio'),
          value: draft.audio ?? true,
          locked: false,
        },
        {
          name: 'promptExtend',
          label: t('painting.settings.param.promptExtend'),
          value: linkOrFile || (draft.promptExtend ?? true),
          locked: linkOrFile,
        },
      ] as const)
    : [];
  const options = model?.supportsWatermark
    ? [
        ...toggles,
        {
          name: 'watermark',
          label: t('painting.settings.param.addWatermark'),
          value: draft.watermark ?? false,
          locked: false,
        } as const,
      ]
    : toggles;

  return (
    <>
      <RouteHeader title={t('iagent.studio.title')} />
      <KeyboardAwareScrollView
        style={styles.scroll}
        bottomOffset={20}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: bottom + 24 }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        mode="layout"
      >
        <View className="mx-auto w-full max-w-2xl gap-5 px-4 py-4">
          <Tabs
            accessibilityLabel={t('iagent.studio.title')}
            items={MEDIA_KINDS.map((value) => ({
              label: t(kindLabels[value]),
              testID: `iagent-studio-tab-${value}`,
              value,
            }))}
            onValueChange={setKind}
            value={kind}
          />
          <View className="gap-4 rounded-3xl border border-border-subtle bg-card p-4">
            {catalog.isPending ? (
              <ContentState.Loading />
            ) : catalog.isError ? (
              <ContentState.Error
                title={t('iagent.catalogFailed')}
                primaryAction={{
                  children: t('common.retry'),
                  onPress: () => void catalog.refetch(),
                }}
              />
            ) : !model ? (
              <Text className="text-sm text-muted-foreground">{t('iagent.studio.noModels')}</Text>
            ) : (
              <>
                {renderField('model')}
                <TextField>
                  <TextField.Label>{t('painting.focus.info.prompt')}</TextField.Label>
                  <Input
                    accessibilityLabel={t('painting.focus.info.prompt')}
                    disabled={preparing}
                    multiline
                    maxLength={model.promptLimit ?? (image ? 10_000 : undefined)}
                    onChangeText={(prompt) => updateDraft({ prompt })}
                    placeholder={t(
                      kind === 'video' ? 'iagent.studio.videoPrompt' : 'painting.input.placeholder',
                    )}
                    testID="iagent-studio-prompt"
                    value={draft.prompt}
                  />
                </TextField>
                {wan ? renderField('wanMode') : null}
                {!wan &&
                model.referenceRoles?.includes('first_frame') &&
                model.referenceRoles.includes('reference_image')
                  ? renderField('referenceMode')
                  : null}
                {referenceModel && !vectors && (!wan || wanMode !== 'text') ? (
                  <IagentCreativeReferences
                    key={`${modelKey(model)}:${wan ? wanMode : referenceMode}`}
                    model={referenceModel}
                    references={references}
                    frameSlots={frameSlots}
                    disabled={preparing}
                    onChange={(references) => updateDraft({ references })}
                  />
                ) : null}
                <View className="gap-2">
                  {optionLists.ratio.length > 1 || !image ? renderField('ratio') : null}
                  {!gif && !customSize && optionLists.resolution.length
                    ? renderField('resolution')
                    : null}
                  {!image ? renderField('duration') : null}
                  {image && optionLists.outputFormat.length > 1
                    ? renderField('outputFormat')
                    : null}
                  {image && model.supportsQuality ? renderField('quality') : null}
                  {image && model.supportsComplexity ? renderField('complexity') : null}
                  {customSize ? (
                    <View className="flex-row gap-2">
                      <View className="flex-1">
                        {renderNumber('width', t('iagent.studio.width'), '1024')}
                      </View>
                      <View className="flex-1">
                        {renderNumber('height', t('iagent.studio.height'), '1024')}
                      </View>
                    </View>
                  ) : null}
                  {!vectors
                    ? renderNumber(
                        'count',
                        t(image ? 'painting.settings.param.numImages' : 'iagent.studio.videoCount'),
                        '1',
                      )
                    : null}
                  {gif ? (
                    <View className="gap-2">
                      {renderNumber('frameCount', t('painting.settings.param.frameCount'), '9')}
                      {renderNumber(
                        'frameDurationMs',
                        t('painting.settings.param.frameDurationMs'),
                        '200',
                      )}
                    </View>
                  ) : null}
                  {options.map(({ name, label, value, locked }) => (
                    <View
                      className="min-h-10 flex-row items-center justify-between gap-2"
                      key={name}
                    >
                      <Text className="flex-1 text-base text-foreground">{label}</Text>
                      <Switch
                        accessibilityLabel={label}
                        disabled={preparing || locked}
                        onValueChange={(value) => updateDraft({ [name]: value })}
                        testID={`iagent-studio-${name}`}
                        value={value}
                      />
                    </View>
                  ))}
                  {wan ? renderNumber('seed', t('painting.settings.param.seed'), '-1') : null}
                </View>
                <Button
                  disabled={!hasInput || preparing}
                  icon={<SparklesIcon />}
                  loading={preparing}
                  onPress={() => void generate()}
                  size="lg"
                  testID="iagent-studio-generate"
                >
                  {t(kind === 'image' ? 'painting.input.generate' : 'iagent.studio.generateVideo')}
                </Button>
              </>
            )}
          </View>
          {state.isSignedIn && selected ? (
            <TaskResult
              key={`${state.iagentUserId}:${selected.id}`}
              task={selected}
              checkFailed={status.isError}
              onCheck={() => void status.refetch()}
            />
          ) : null}
          {kind === 'image' ? (
            <Button onPress={() => router.push('/drawings')} variant="ghost">
              {t('iagent.studio.customDrawing')}
            </Button>
          ) : null}
          {state.isSignedIn && tasks.length > 1 ? (
            <Section title={t('iagent.studio.history')}>
              {tasks.slice(0, 12).map((task) => (
                <Section.Item
                  key={task.id}
                  label={
                    !task.prompt
                      ? task.modelName
                      : task.prompt.length > 70
                        ? `${task.prompt.slice(0, 70)}…`
                        : task.prompt
                  }
                  description={task.modelName}
                  onPress={() => setTaskId(task.id)}
                />
              ))}
            </Section>
          ) : null}
        </View>
      </KeyboardAwareScrollView>
      {field ? (
        <OptionPickerBottomSheet
          onClose={() => setField(undefined)}
          onValueChange={select}
          open
          options={optionLists[field]}
          selectedValue={fieldValues[field]}
          size="large"
          title={fieldLabels[field]}
        />
      ) : null}
    </>
  );
}

function TaskResult({
  task,
  checkFailed,
  onCheck,
}: {
  task: IagentMediaTask;
  checkFailed: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const { state } = useAccount();
  const { creative } = useIagent();
  const { toast } = useToast();
  const focused = useIsFocused();
  const [index, setIndex] = useState(0);
  const [sharing, setSharing] = useState(false);
  const output = useQuery({
    queryKey: ['iagent', 'creative-output', state.iagentUserId, task.id, index],
    queryFn: () => creative.output(task.id, index),
    enabled: focused && task.status === 'completed',
    retry: false,
  });
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing unavailable');
      await Sharing.shareAsync(await creative.output(task.id, index, { download: true }));
    } catch {
      toast.show({ label: t('iagent.studio.outputFailed'), variant: 'danger' });
    } finally {
      setSharing(false);
    }
  };

  return (
    <View
      className="gap-3 rounded-3xl border border-border-subtle bg-card p-4"
      testID="iagent-studio-result"
    >
      <View className="gap-1">
        <Text className="font-medium text-foreground" numberOfLines={2}>
          {task.prompt}
        </Text>
        <Text className="text-sm text-muted-foreground">{task.modelName}</Text>
      </View>
      {task.status === 'pending' || task.status === 'submitting' ? (
        <View className="gap-2">
          <ContentState.Loading title={t('iagent.studio.running')} />
          {task.status === 'pending' ? (
            <Button onPress={onCheck} variant="outline">
              {t(checkFailed ? 'common.retry' : 'iagent.refresh')}
            </Button>
          ) : null}
        </View>
      ) : task.status === 'unknown' || task.status === 'failed' ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger" selectable>
          {task.status === 'unknown'
            ? t('iagent.studio.unknown')
            : task.error || t('painting.status.failed')}
        </Text>
      ) : (
        <>
          {focused && output.data ? (
            task.kind === 'video' ? (
              <CreativeVideo uri={output.data} />
            ) : (
              <Image
                className="aspect-square w-full rounded-xl bg-secondary"
                contentFit="contain"
                source={output.data}
              />
            )
          ) : output.isError ? (
            <ContentState.Error
              title={t('iagent.studio.outputFailed')}
              primaryAction={{ children: t('common.retry'), onPress: () => void output.refetch() }}
            />
          ) : (
            <ContentState.Loading />
          )}
          {task.outputs > 1 ? (
            <View className="flex-row flex-wrap gap-2">
              {Array.from({ length: task.outputs }, (_, item) => (
                <Button
                  key={item}
                  onPress={() => setIndex(item)}
                  size="sm"
                  variant={item === index ? 'tonal' : 'outline'}
                >
                  {String(item + 1)}
                </Button>
              ))}
            </View>
          ) : null}
          <Button
            disabled={sharing}
            loading={sharing}
            onPress={() => void share()}
            variant="outline"
          >
            {t('common.share')}
          </Button>
        </>
      )}
    </View>
  );
}

function CreativeVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return (
    <View className="overflow-hidden rounded-xl bg-secondary">
      <VideoView
        fullscreenOptions={{ enable: true }}
        nativeControls
        player={player}
        style={styles.video}
        surfaceType="textureView"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  video: { aspectRatio: 16 / 9, width: '100%' },
});
