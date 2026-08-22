import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import {
  REMOTE_MAX_ATTACHMENT_BYTES,
  REMOTE_MAX_ATTACHMENT_NAME_LENGTH,
  isRemoteImageMediaType,
  remoteFileExtension
} from '@shared/remote'
import { base64Bytes } from './chunks'

/**
 * 컴포저가 들고 있는 첨부 1개. **본문(base64)까지 여기 들어 있다** — 고르는 순간 읽어 두면
 * 크기 초과를 보내기 전에 말해 줄 수 있고, 보낼 때는 조각내 올리기만 하면 된다.
 */
export interface PendingAttachment {
  /** 업로드를 묶는 id. 랩탑의 검증기가 `[A-Za-z0-9_-]{8,64}` 만 받는다. */
  id: string
  name: string
  mediaType: string
  base64: string
  /** 원본 바이트 수(base64 가 아니라). 예산 표시와 상한 판단에 쓴다. */
  bytes: number
  /** 이미지면 썸네일로 그릴 로컬 uri. 파일이면 없다. */
  previewUri?: string
}

/** 고르기가 실패한 이유. 화면이 그대로 띄운다. */
export class AttachmentError extends Error {}

/**
 * 이미지를 줄여 나가는 사다리.
 *
 * 첫 칸(1568px)은 Claude 가 이미지를 내부에서 리사이즈하는 기준과 같다 — 그보다 크게 보내도
 * 모델이 보는 것은 달라지지 않으면서 릴레이 예산만 먹는다. 상한을 못 맞추면 한 칸씩 내려간다.
 */
const IMAGE_LADDER: ReadonlyArray<{ width: number; compress: number }> = [
  { width: 1568, compress: 0.7 },
  { width: 1280, compress: 0.6 },
  { width: 1024, compress: 0.5 },
  { width: 800, compress: 0.4 }
]

let counter = 0

/** 업로드 id. 무작위성이 필요한 값이 아니라 **겹치지 않기만** 하면 된다. */
function uploadId(): string {
  counter += 1
  return `u${Date.now().toString(36)}${counter.toString(36).padStart(3, '0')}`
}

/** 표시 이름을 상한 안으로 줄인다. 확장자는 남긴다 — 랩탑이 그것으로 파일 종류를 판단한다. */
function trimName(name: string): string {
  if (name.length <= REMOTE_MAX_ATTACHMENT_NAME_LENGTH) return name
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name.slice(0, REMOTE_MAX_ATTACHMENT_NAME_LENGTH)
  const extension = name.slice(dot)
  return name.slice(0, Math.max(1, REMOTE_MAX_ATTACHMENT_NAME_LENGTH - extension.length)) + extension
}

function readableSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 사진 보관함에서 고른다. */
export async function pickImages(limit: number): Promise<PendingAttachment[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    throw new AttachmentError('Wooi needs access to your photos to attach one.')
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    // 원본을 그대로 받는다 — 줄이는 것은 아래에서 상한을 보고 직접 한다.
    quality: 1,
    exif: false
  })
  if (result.canceled) return []
  return Promise.all(result.assets.map((asset) => normalizeImage(asset)))
}

/** 카메라로 찍어서 붙인다. */
export async function pickCameraPhoto(): Promise<PendingAttachment[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync()
  if (!permission.granted) {
    throw new AttachmentError('Wooi needs access to your camera to take a photo.')
  }
  const result = await ImagePicker.launchCameraAsync({ quality: 1, exif: false })
  if (result.canceled) return []
  return Promise.all(result.assets.map((asset) => normalizeImage(asset)))
}

/** 파일 앱에서 문서를 고른다. */
export async function pickDocuments(limit: number): Promise<PendingAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: limit > 1,
    // 원본 uri 는 앱 밖(iCloud·SAF)을 가리킬 수 있어 곧바로 읽지 못한다. 캐시로 복사받는다.
    copyToCacheDirectory: true
  })
  if (result.canceled) return []
  if (result.assets.length > limit) {
    throw new AttachmentError(`You can attach ${limit} more file${limit === 1 ? '' : 's'}.`)
  }
  return Promise.all(result.assets.map((asset) => readDocument(asset)))
}

async function readDocument(asset: DocumentPicker.DocumentPickerAsset): Promise<PendingAttachment> {
  const name = trimName(asset.name)
  // **확장자로 판단한다.** 문서 선택기의 mimeType 은 플랫폼마다 비어 있거나 제각각인데,
  // 정작 랩탑에서 파일을 여는 도구는 확장자를 본다(랩탑의 검증기도 같은 규칙이다).
  if (remoteFileExtension(name) === null) {
    throw new AttachmentError(`Wooi can't attach "${asset.name}" — that file type isn't supported.`)
  }
  const file = new File(asset.uri)
  const size = asset.size ?? file.size
  if (size === 0) throw new AttachmentError(`"${name}" is empty.`)
  if (size > REMOTE_MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `"${name}" is ${readableSize(size)}. Files must be under ${readableSize(REMOTE_MAX_ATTACHMENT_BYTES)}.`
    )
  }
  const base64 = await file.base64()
  return {
    id: uploadId(),
    name,
    mediaType: asset.mimeType ?? 'application/octet-stream',
    base64,
    bytes: base64Bytes(base64)
  }
}

/**
 * 사진 하나를 전송할 수 있는 모양으로 만든다.
 *
 * 이미 상한 안에 드는 사진은 **손대지 않는다** — PNG 의 투명도나 GIF 의 움직임을 JPEG 로
 * 갈아 끼우면서 잃을 이유가 없다. 넘칠 때만 사다리를 타고 JPEG 로 줄인다.
 */
async function normalizeImage(asset: ImagePicker.ImagePickerAsset): Promise<PendingAttachment> {
  const mediaType = asset.mimeType ?? 'image/jpeg'
  const name = trimName(asset.fileName ?? `photo.${mediaType === 'image/png' ? 'png' : 'jpg'}`)

  if (isRemoteImageMediaType(mediaType)) {
    const file = new File(asset.uri)
    const size = asset.fileSize ?? file.size
    if (size > 0 && size <= REMOTE_MAX_ATTACHMENT_BYTES) {
      const base64 = await file.base64()
      return {
        id: uploadId(),
        name,
        mediaType,
        base64,
        bytes: base64Bytes(base64),
        previewUri: asset.uri
      }
    }
  }

  for (const step of IMAGE_LADDER) {
    // 원본보다 크게 늘리지 않는다 — 화질은 그대로인데 바이트만 불어난다.
    const width = asset.width > 0 ? Math.min(asset.width, step.width) : step.width
    const rendered = await ImageManipulator.manipulate(asset.uri).resize({ width }).renderAsync()
    const saved = await rendered.saveAsync({
      format: SaveFormat.JPEG,
      compress: step.compress,
      base64: true
    })
    const base64 = saved.base64 ?? ''
    const bytes = base64Bytes(base64)
    if (bytes > 0 && bytes <= REMOTE_MAX_ATTACHMENT_BYTES) {
      return {
        id: uploadId(),
        name: name.replace(/\.[^.]+$/, '') + '.jpg',
        mediaType: 'image/jpeg',
        base64,
        bytes,
        previewUri: saved.uri
      }
    }
  }

  throw new AttachmentError(
    `That photo is too detailed to send from your phone — it stays over ${readableSize(REMOTE_MAX_ATTACHMENT_BYTES)} even at the smallest size.`
  )
}
