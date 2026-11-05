import type { Kind, Lang, Reference, Variant } from './types';
import { isDepthVariant, poseDepthOrigin } from './pose-depth';
import { isCustomAsset } from './custom-assets';
import { imageRequestEndpoint } from './image-transport';
import { generateWithJobApi } from './image-job-transport';

export interface ImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  rememberKey: boolean;
}
interface ReferenceDetails {
  title: Reference['title'];
  keywords: Reference['keywords'];
  variant: Variant;
}
export interface GalleryImageReference extends ReferenceDetails {
  kind: Kind;
}
export interface UploadedImageReference extends ReferenceDetails {
  kind: 'character' | 'costume';
  file: File;
}
export type ImageReference = GalleryImageReference | UploadedImageReference;
export interface GenerationJob {
  model: string;
  references: ImageReference[];
  prompt: string;
  status: 'loading' | 'error' | 'success' | 'cancelled';
  result?: string;
  error?: string;
  size?: string;
  quality?: ImageConfig['quality'];
  restored?: boolean;
}

const SETTINGS_KEY = 'opc-image-settings';
const SESSION_KEY = 'opc-image-session-key';
export const defaultImageConfig: ImageConfig = {
  baseUrl: 'https://atomflow.vip',
  apiKey: '',
  model: 'gpt-image-2',
  size: '1024x1536',
  quality: 'auto',
  rememberKey: false,
};
export const imageSizes = ['1024x1024', '1024x1536', '1536x1024', '2048x2048', 'auto'];

export function imageEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('invalidEndpoint');
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/images\/(edits|generations)$/, '');
  if (!pathname.endsWith('/v1')) pathname += '/v1';
  return `${url.origin}${pathname}/images/edits`;
}

export function normalizeImageConfig(config: ImageConfig): ImageConfig {
  const endpoint = imageEndpoint(config.baseUrl);
  if (!config.apiKey.trim() || !config.model.trim() || /[\r\n]/.test(config.apiKey))
    throw Error('missingConfig');
  if (
    !imageSizes.includes(config.size) ||
    !['auto', 'low', 'medium', 'high'].includes(config.quality)
  )
    throw Error('invalidConfig');
  return {
    ...config,
    baseUrl: endpoint.replace(/\/images\/edits$/, ''),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
  };
}

export function loadImageConfig(): ImageConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved || typeof saved.baseUrl !== 'string' || typeof saved.model !== 'string')
      return { ...defaultImageConfig };
    const rememberKey = saved.rememberKey === true;
    const apiKey = rememberKey ? saved.apiKey : sessionStorage.getItem(SESSION_KEY);
    const candidate = {
      ...defaultImageConfig,
      ...saved,
      // Migrate the retired model default while preserving the service and key.
      model: saved.model.startsWith('grok-') ? defaultImageConfig.model : saved.model,
      rememberKey,
      apiKey: typeof apiKey === 'string' ? apiKey : '',
    };
    // Keep the endpoint settings when a session-only key has expired.
    normalizeImageConfig({ ...candidate, apiKey: candidate.apiKey || 'validation-only' });
    return candidate;
  } catch {
    return { ...defaultImageConfig };
  }
}

export function saveImageConfig(config: ImageConfig): ImageConfig {
  const valid = normalizeImageConfig(config);
  const { apiKey, ...settings } = valid;
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...settings, ...(valid.rememberKey ? { apiKey } : {}) }),
  );
  if (valid.rememberKey) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, apiKey);
  return valid;
}

export function clearImageConfig() {
  localStorage.removeItem(SETTINGS_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

export function referencePrompt(references: ImageReference[], lang: Lang): string {
  const hasCharacter = references.some((ref) => ref.kind === 'character');
  const roles = {
    pose: {
      zh: '僅採用此圖目前顯示的動作與單一觀察角度。保持頭部朝向、肩胯方向、肘腕位置、手勢、腿部彎曲及遮擋關係，不擅自把雙手移到身後。取景範圍跟隨此圖。',
      en: "Use only the pose and single viewpoint shown in this image. Preserve head direction, shoulder and hip orientation, elbows, wrists, hand gestures, bent legs and occlusion. Do not move the hands behind the back unless shown. Match this image's framing.",
    },
    costume: {
      zh: '僅提取可見服飾、鞋履及配飾的款式、顏色、材質與穿戴方式，穿到同一個人物身上；不複製陳列版面、空白間距或隱形人台外觀。',
      en: 'Transfer only the visible garments, footwear and accessories, including design, colors, materials and placement, onto the same person. Do not copy the product arrangement, empty spacing or ghost-mannequin appearance.',
    },
    character: {
      zh: '僅保留此人物的身份、五官、臉型、髮型髮色、膚色與畫風；不複製人物參考的動作、服飾或頭像裁切，不額外生成頭像或其他視角。',
      en: "Preserve only this person's identity, facial features, face shape, hairstyle, hair color, skin tone and visual style. Do not copy this reference's pose, clothing or portrait crop, or add separate portraits or other views.",
    },
  };
  const details = references
    .map((ref, index) => {
      // Catalog keywords describe discovery and batches, not generation instructions.
      const detail =
        lang === 'zh'
          ? `參考圖 ${index + 1}（${ref.kind === 'pose' ? '姿勢' : ref.kind === 'costume' ? '服裝' : '人物'}）：${roles[ref.kind].zh}`
          : `Reference ${index + 1} (${ref.kind}): ${roles[ref.kind].en}`;
      if (ref.kind !== 'pose' || !isDepthVariant(ref.variant)) return detail;
      return `${detail} ${
        lang === 'zh'
          ? '此圖為深度圖，越亮越靠近鏡頭。僅參考動作、透視與遮擋關係，不複製灰階、深色背景或人偶外觀。'
          : 'This is a depth map: brighter areas are closer to the camera. Use only its pose, perspective and occlusion; do not copy the grayscale, dark background or mannequin appearance.'
      }`;
    })
    .join('\n');
  const output =
    lang === 'zh'
      ? '最終輸出只有一張連續畫面、一個人物、一個選定視角。禁止多面板、分欄、分鏡、角色設定頁、局部特寫插圖、其他角度附圖或重複人物。所有參考資訊融合到這一個人物中。'
      : 'Final output: one continuous scene, one person and one selected viewpoint only. No panels, columns, storyboards, character sheets, inset close-ups, additional-angle images or repeated people. Combine all references into that one person.';
  if (hasCharacter)
    return lang === 'zh'
      ? `結合所附參考圖創作一幅完整的人物圖。人物參考決定身份與畫風：保留其五官、臉型、髮型髮色、膚色與體型比例；姿勢參考只決定動作、重心與觀察角度，不遷移人偶線條和關節；服裝參考只決定穿搭、顏色、版型與材質，不遷移服裝模特兒的臉和站姿。讓服裝隨動作自然形變，人物完整著裝，背景簡潔，不加入文字或浮水印，不製作拼貼或對照圖。\n${details}\n${output}`
      : `Create one complete character image from the attached references. Use the character reference for identity and visual style, preserving the face, hairstyle, hair color, skin tone and body proportions. Use the pose reference only for gesture, balance and viewpoint, without mannequin lines or joints. Use the costume reference only for outfit, colors, garment shape and materials, without copying the outfit model's face or stance. Make clothing drape naturally with the pose. Keep the character fully clothed, with a simple background and no text, watermark, collage or comparison layout.\n${details}\n${output}`;
  return lang === 'zh'
    ? `結合所附參考圖創作一幅完整的角色插畫。遵循姿勢參考的動作與重心，保留服裝參考的穿搭與材質細節；角色完整著裝，背景簡潔，不加入文字或浮水印。\n${details}\n${output}`
    : `Create a finished character illustration from the attached references. Follow the pose and balance of the pose reference and the garment and material details of the costume reference. Keep the character fully clothed, with a simple background and no text or watermark.\n${details}\n${output}`;
}

export class ImageGenerationError extends Error {
  constructor(
    public code: string,
    message = '',
  ) {
    super(message);
  }
}

export async function validateReferenceFile(
  file: File,
  kind: 'character' | 'costume',
): Promise<void> {
  if (file.size > 10 * 1024 * 1024) throw new ImageGenerationError(`${kind}TooLarge`);
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...bytes);
  const mime = signature.startsWith('\x89PNG\r\n\x1a\n')
    ? 'image/png'
    : signature.startsWith('\xff\xd8\xff')
      ? 'image/jpeg'
      : signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
        ? 'image/webp'
        : '';
  if (!mime || mime !== file.type) throw new ImageGenerationError(`${kind}Invalid`);
}

function safeMessage(message: string, key: string): string {
  return message
    .split(key)
    .join('[redacted]')
    .split(encodeURIComponent(key))
    .join('[redacted]')
    .replace(/[\u0000-\u001f]/g, ' ')
    .slice(0, 350);
}

export function imageResult(payload: unknown): string {
  const row = (payload as { data?: { b64_json?: unknown; url?: unknown }[] })?.data?.[0];
  if (typeof row?.b64_json === 'string') {
    const b64 = row.b64_json;
    if (b64.length > 100_000_000 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      throw new ImageGenerationError('invalidResult');
    const signature = atob(b64.slice(0, 32));
    const mime = signature.startsWith('\x89PNG\r\n\x1a\n')
      ? 'image/png'
      : signature.startsWith('\xff\xd8\xff')
        ? 'image/jpeg'
        : signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
          ? 'image/webp'
          : '';
    if (!mime) throw new ImageGenerationError('invalidResult');
    return `data:${mime};base64,${b64}`;
  }
  if (typeof row?.url === 'string') {
    try {
      const url = new URL(row.url);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch {
      /* Report one consistent error for invalid provider output. */
    }
  }
  throw new ImageGenerationError('invalidResult');
}

export async function generateReferenceImage(
  config: ImageConfig,
  references: ImageReference[],
  prompt: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const valid = normalizeImageConfig(config);
  if (!references.length || !prompt.trim()) throw new ImageGenerationError('missingReference');
  const jobApiUrl = import.meta.env.VITE_IMAGE_JOB_API_URL || '';
  const timeout = new AbortController();
  // Self-hosted services (e.g. a queued Colab WebUI) can take minutes; match the 10-minute message.
  const timer = setTimeout(() => timeout.abort(), 600_000);
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    const urls = references.map((reference) => {
      if ('file' in reference) return null;
      const url = new URL(reference.variant.original);
      const allowedOrigins = [
        `https://ai-${reference.kind === 'character' ? 'portrait' : reference.kind}-gallery.pages.dev`,
        ...(reference.kind === 'costume' ? ['https://ai-costume-anime-gallery.pages.dev'] : []),
        ...(reference.kind === 'pose' ? [poseDepthOrigin] : []),
      ];
      if (
        url.username ||
        url.password ||
        (!allowedOrigins.includes(url.origin) && !isCustomAsset(url.href, reference.kind))
      )
        throw new ImageGenerationError('referenceFailed');
      return url.href;
    });
    for (const reference of references)
      if ('file' in reference) await validateReferenceFile(reference.file, reference.kind);
    const jobResult = await generateWithJobApi(
      jobApiUrl,
      valid,
      imageEndpoint(valid.baseUrl),
      references,
      prompt,
      combined,
    ).catch((error) => {
      if (combined.aborted) throw error;
      const status = Number((error as { jobStatus?: unknown })?.jobStatus) || 0;
      const detail = safeMessage(error instanceof Error ? error.message : '', valid.apiKey);
      if ([400, 401, 403].includes(status))
        throw new ImageGenerationError(
          'providerFailed',
          `HTTP ${status}${detail ? ` · ${detail}` : ''}`,
        );
      throw new ImageGenerationError('networkFailed', detail);
    });
    if (jobResult)
      return imageResult(
        jobResult.startsWith('data:')
          ? { data: [{ b64_json: jobResult.split(',', 2)[1] }] }
          : { data: [{ url: jobResult }] },
      );
    const form = new FormData();
    form.set('model', valid.model);
    form.set('prompt', prompt.trim());
    form.set('n', '1');
    form.set('size', valid.size);
    form.set('quality', valid.quality);
    for (const [index, reference] of references.entries()) {
      combined.throwIfAborted();
      let blob: Blob;
      if ('file' in reference) blob = reference.file;
      else {
        const response = await fetcher(urls[index]!, {
          signal: combined,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }).catch((error) => {
          if (combined.aborted) throw error;
          throw new ImageGenerationError('referenceFailed');
        });
        if (!response.ok)
          throw new ImageGenerationError('referenceFailed', `HTTP ${response.status}`);
        blob = await response.blob();
      }
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) ||
        !blob.size ||
        blob.size > 50 * 1024 * 1024
      )
        throw new ImageGenerationError('referenceFailed');
      form.append(
        'image[]',
        blob,
        `${'file' in reference ? `${reference.kind}-upload` : reference.variant.id}.${blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp'}`,
      );
    }
    combined.throwIfAborted();
    const endpoint = imageRequestEndpoint(
      imageEndpoint(valid.baseUrl),
      import.meta.env.DEV && !import.meta.env.SSR,
      import.meta.env.VITE_IMAGE_PROXY_URL,
    );
    const response = await fetcher(endpoint, {
      method: 'POST',
      signal: combined,
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: `Bearer ${valid.apiKey}` },
      body: form,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
      throw new ImageGenerationError(
        'providerFailed',
        `HTTP ${response.status}${message ? ` · ${safeMessage(message, valid.apiKey)}` : ''}`,
      );
    }
    return imageResult(payload);
  } catch (error) {
    if (signal.aborted) throw new ImageGenerationError('cancelled');
    if (timeout.signal.aborted) throw new ImageGenerationError('timedOut');
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError('networkFailed');
  } finally {
    clearTimeout(timer);
  }
}
