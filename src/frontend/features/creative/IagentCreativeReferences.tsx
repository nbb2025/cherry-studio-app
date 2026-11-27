import ImageUpIcon from '@cherrystudio/app-icons/icons/image-up';
import XIcon from '@cherrystudio/app-icons/icons/x';
import { Button, Image, Input, TextField, useToast } from '@cherrystudio/ui/components';
import { createAudioPlayer } from 'expo-audio';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ComponentRef, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { createScheduledFlush } from '@/frontend/utils/scheduling';
import type {
  IagentMediaModel,
  IagentMediaReference,
  IagentReferenceKind,
  IagentReferenceRole,
} from '@/shared/contracts/iagentCreative';

export type CreativeReference = IagentMediaReference & { id: string; name: string };

const referenceKinds = ['image', 'video', 'audio', 'file'] as const;
const documentTypes = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.apple.keynote',
  'application/vnd.apple.pages',
  'application/vnd.apple.numbers',
];
const kindLabels = {
  image: 'iagent.studio.image',
  video: 'iagent.studio.video',
  audio: 'iagent.studio.referenceAudio',
  file: 'iagent.studio.referenceFile',
  link: 'iagent.studio.referenceLink',
} as const;
const frameLabels = {
  first_frame: 'iagent.studio.firstFrame',
  last_frame: 'iagent.studio.lastFrame',
} as const;

async function readAudioDuration(uri: string): Promise<number | undefined> {
  const player = createAudioPlayer(uri);
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const timeout = createScheduledFlush(() => resolve(undefined));
  let subscription: { remove(): void } | undefined;
  try {
    subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.duration > 0) resolve(status.duration);
      else if (status.error) resolve(undefined);
    });
    if (player.currentStatus.duration > 0) return player.currentStatus.duration;
    timeout.schedule(8000);
    return await promise;
  } finally {
    timeout.cancel();
    subscription?.remove();
    player.release();
  }
}

export function IagentCreativeReferences({
  model,
  references,
  frameSlots,
  disabled,
  onChange,
}: {
  model: IagentMediaModel;
  references: CreativeReference[];
  frameSlots?: readonly ('first_frame' | 'last_frame')[];
  disabled: boolean;
  onChange: (references: CreativeReference[]) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const [link, setLink] = useState('');
  const container = useRef<ComponentRef<typeof View>>(null);

  const max = (kind: IagentReferenceKind) => model.referenceLimits?.[kind] ?? 0;
  const used = (kind: IagentReferenceKind) =>
    references.filter((item) => (item.kind ?? 'image') === kind).length;

  const add = async (kind: Exclude<IagentReferenceKind, 'link'>, role?: IagentReferenceRole) => {
    if (picking) return;
    setPicking(true);
    try {
      const limit = role === 'first_frame' || role === 'last_frame' ? 1 : max(kind) - used(kind);
      if (limit < 1) return;
      const assets: CreativeReference[] = [];
      if (kind === 'audio' || kind === 'file') {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: limit > 1,
          type: kind === 'audio' ? 'audio/*' : documentTypes,
        });
        if (result.canceled) return;
        for (const { uri, name, mimeType } of result.assets.slice(0, limit)) {
          const duration = kind === 'audio' ? await readAudioDuration(uri) : undefined;
          assets.push({ id: randomUUID(), uri, name, mimeType, kind, duration });
        }
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: [kind === 'image' ? 'images' : 'videos'],
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          quality: 1,
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        if (result.canceled) return;
        for (const asset of result.assets.slice(0, limit)) {
          assets.push({
            id: randomUUID(),
            uri: asset.uri,
            name: asset.fileName ?? asset.uri.split('/').at(-1) ?? kind,
            mimeType: asset.mimeType,
            duration: asset.duration ? asset.duration / 1000 : undefined,
            kind,
            role: kind === 'image' ? role : undefined,
          });
        }
      }
      if (container.current) onChange([...references, ...assets]);
    } catch {
      if (container.current)
        toast.show({ label: t('iagent.studio.mediaReferenceFailed'), variant: 'danger' });
    } finally {
      if (container.current) setPicking(false);
    }
  };

  const addLink = () => {
    try {
      const url = new URL(link);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
        throw new Error();
      onChange([
        ...references,
        { id: randomUUID(), kind: 'link', name: url.hostname, uri: url.href },
      ]);
      setLink('');
    } catch {
      toast.show({ label: t('painting.input.invalidParameters'), variant: 'danger' });
    }
  };

  const buttons = frameSlots
    ? frameSlots
        .filter((slot) => !references.some((item) => item.role === slot))
        .map((role) => ({ key: role, label: t(frameLabels[role]), pick: () => add('image', role) }))
    : referenceKinds
        .filter((kind) => max(kind) > used(kind) && (kind !== 'file' || used('link') === 0))
        .map((kind) => ({
          key: kind,
          label: kind === 'image' ? t('iagent.studio.reference') : t(kindLabels[kind]),
          pick: () =>
            add(
              kind,
              kind === 'image' &&
                model.kind === 'video' &&
                model.referenceRoles?.includes('reference_image')
                ? 'reference_image'
                : undefined,
            ),
        }));
  const showLink = !frameSlots && max('link') > used('link') && used('file') === 0;
  if (!references.length && !buttons.length && !showLink) return null;

  return (
    <View className="gap-3" ref={container}>
      {references.length ? (
        <View className="flex-row flex-wrap gap-2">
          {references.map((reference) => (
            <View className="w-24 gap-1 rounded-xl bg-secondary p-1" key={reference.id}>
              {reference.kind === 'image' || !reference.kind ? (
                <Image
                  className="h-16 w-full rounded-lg"
                  contentFit="cover"
                  source={reference.uri}
                />
              ) : (
                <Text className="px-1 py-2 text-xs text-muted-foreground">
                  {t(kindLabels[reference.kind])}
                </Text>
              )}
              <View className="flex-row items-center gap-1">
                <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                  {reference.role && reference.role !== 'reference_image'
                    ? t(frameLabels[reference.role])
                    : reference.name}
                </Text>
                <Button
                  accessibilityLabel={t('common.remove')}
                  disabled={disabled || picking}
                  icon={<XIcon />}
                  onPress={() => onChange(references.filter((item) => item.id !== reference.id))}
                  size="xs"
                  variant="ghost"
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {buttons.map(({ key, label, pick }) => (
          <Button
            disabled={disabled || picking}
            icon={<ImageUpIcon />}
            key={key}
            onPress={() => void pick()}
            size="sm"
            testID={`iagent-reference-${key}`}
            variant="outline"
          >
            {label}
          </Button>
        ))}
      </View>
      {showLink ? (
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <TextField>
              <TextField.Label>{t('iagent.studio.referenceLink')}</TextField.Label>
              <Input
                accessibilityLabel={t('iagent.studio.referenceLink')}
                autoCapitalize="none"
                disabled={disabled || picking}
                keyboardType="url"
                onChangeText={setLink}
                placeholder="https://"
                value={link}
              />
            </TextField>
          </View>
          <Button
            disabled={disabled || picking || !link.trim()}
            onPress={addLink}
            variant="outline"
          >
            {t('common.add')}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
