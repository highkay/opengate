import crypto from 'node:crypto';
import { getTokenWithAccount, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';

/**
 * Character limit enforced by Qwen on message content.
 * When a message exceeds this, it must be uploaded as a file instead.
 * Source: Qwen web UI error message — "more than 131072 characters".
 */
export const QWEN_CONTENT_CHAR_LIMIT = 131_072;

// --- Types ---

interface StsTokenResponse {
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
  bucketname: string;
  region: string;
  endpoint: string;
  file_id: string;
  file_path: string;
  file_url: string;
}

/** Error from getstsToken with structured upstream fields for account retry. */
export class StsTokenError extends Error {
  readonly code: string;
  readonly upstreamStatus: number;
  readonly retryHours?: number;

  constructor(message: string, code: string, upstreamStatus: number, retryHours?: number) {
    super(message);
    this.name = 'StsTokenError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.retryHours = retryHours;
  }
}

function isValidStsToken(data: unknown): data is StsTokenResponse {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.access_key_id === 'string' &&
    !!d.access_key_id &&
    typeof d.access_key_secret === 'string' &&
    !!d.access_key_secret &&
    typeof d.security_token === 'string' &&
    !!d.security_token &&
    typeof d.bucketname === 'string' &&
    !!d.bucketname &&
    typeof d.endpoint === 'string' &&
    !!d.endpoint &&
    typeof d.file_id === 'string' &&
    !!d.file_id &&
    typeof d.file_path === 'string' &&
    !!d.file_path &&
    typeof d.file_url === 'string' &&
    !!d.file_url
  );
}

/**
 * Parse getstsToken JSON body. Rejects success:false (e.g. RateLimited) and incomplete STS payloads.
 * On RateLimited, throttles the account for the duration Qwen reports (`num` hours).
 * Exported for unit tests.
 */
export function parseStsTokenResponse(resData: any, email: string): StsTokenResponse {
  // Qwen returns HTTP 200 with { success:false, data:{ code, details, num } } on daily limits.
  // `data` is present but is NOT STS credentials — must not treat it as upload tokens.
  if (resData?.success === false || !isValidStsToken(resData?.data)) {
    const errBody = resData?.data && typeof resData.data === 'object' ? resData.data : resData;
    const code = errBody?.code || resData?.code || 'UnexpectedStsResponse';
    const details = String(
      errBody?.details || errBody?.message || resData?.message || 'getstsToken returned invalid STS credentials',
    ).replace(/\.+$/, '');
    const retryHours = typeof errBody?.num === 'number' ? errBody.num : undefined;
    const wait = retryHours !== undefined ? ` Wait about ${retryHours} hour(s) before trying again.` : '';

    if (code === 'RateLimited') {
      // Use full duration from Qwen (same as chat stream RateLimited handling) — do not cap.
      const throttleMs = (retryHours || 1) * 3600_000;
      throttleAccount(email, throttleMs);
      logStore.log(
        'warn',
        'upload',
        `[FileUpload] getstsToken RateLimited for ${email} — throttled ${retryHours || 1}h: ${details}`,
      );
    }

    throw new StsTokenError(
      `getstsToken failed: ${code} — ${details}.${wait}`,
      code,
      code === 'RateLimited' ? 429 : 502,
      retryHours,
    );
  }

  return resData.data;
}

/**
 * Qwen web UI file attachment format — exact structure from browser HAR capture.
 * The web UI sends this complex nested object in messages[].files[].
 */
export interface QwenFileAttachment {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: {
      name: string;
      size: number;
      content_type: string;
      parse_meta?: { parse_status: string };
    };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string; // MIME type
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string;
  uploadTaskId: string;
}

// --- Step 1: Get STS credentials for OSS upload ---

async function getstsToken(email: string, filename: string, filesize: number, filetype: string = 'file'): Promise<StsTokenResponse> {
  const url = `${QWEN_API_BASE}/api/v2/files/getstsToken`;
  const body = JSON.stringify({
    filename,
    filesize: String(filesize),
    filetype,
  });

  const tokenInfo = await getTokenWithAccount(email);
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
  const response = await browserlessFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      cookie: cookieStr,
      origin: QWEN_API_BASE,
    },
    body,
    accountEmail: email,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`getstsToken failed: ${response.status} — ${errText.substring(0, 200)}`);
  }
  const resText = await response.text();
  let resData: any;
  try {
    resData = JSON.parse(resText);
  } catch {
    throw new Error(`getstsToken returned non-JSON response: ${resText.substring(0, 200)}`);
  }
  return parseStsTokenResponse(resData, email);
}

// --- Step 2: Upload file content to Alibaba Cloud OSS ---

function hmacSha1Base64(key: string, message: string): string {
  return crypto.createHmac('sha1', key).update(message).digest('base64');
}

function buildOssCanonicalRequest(
  method: string,
  contentType: string,
  date: string,
  securityToken: string,
  bucket: string,
  key: string,
): string {
  return [
    method,
    '', // Content-MD5 (empty)
    contentType,
    date, // Date header
    `x-oss-security-token:${securityToken}`,
    `/${bucket}/${key}`,
  ].join('\n');
}

async function uploadToOss(sts: StsTokenResponse, fileContent: Buffer, contentType: string): Promise<string> {
  const date = new Date().toUTCString();
  const key = sts.file_path;
  if (typeof key !== 'string' || !key) {
    throw new Error('Invalid STS token: missing file_path (cannot upload to OSS)');
  }

  // file_path may or may not include the bucket prefix.
  // CanonicalizedResource = /{bucket}/{objectKey} where objectKey is WITHOUT the bucket prefix.
  // If file_path starts with bucket name + '/', strip it to get the object key.
  let objectKey = key;
  const bucketPrefix = `${sts.bucketname}/`;
  if (objectKey.startsWith(bucketPrefix)) {
    objectKey = objectKey.substring(bucketPrefix.length);
  }

  logStore.log(
    'debug',
    'upload',
    `[FileUpload] OSS upload — endpoint=${sts.endpoint}, bucket=${sts.bucketname}, key=${key}, objectKey=${objectKey}`,
  );

  const canonicalRequest = buildOssCanonicalRequest('PUT', contentType, date, sts.security_token, sts.bucketname, objectKey);

  logStore.log('debug', 'upload', `[FileUpload] OSS canonical request:\n${canonicalRequest}`);

  const signature = hmacSha1Base64(sts.access_key_secret, canonicalRequest);

  // Build OSS endpoint URL: https://{bucket}.{endpoint}/{objectKey}
  let endpoint = sts.endpoint.replace(/\/+$/, '');
  if (!endpoint.includes(sts.bucketname)) {
    endpoint = `https://${sts.bucketname}.${endpoint.replace(/^https?:\/\//, '')}`;
  }
  const uploadUrl = `${endpoint}/${objectKey}`;

  logStore.log('debug', 'upload', `[FileUpload] OSS upload URL: ${uploadUrl}`);

  const authHeader = `OSS ${sts.access_key_id}:${signature}`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      Date: date,
      Authorization: authHeader,
      'x-oss-security-token': sts.security_token,
    },
    body: fileContent as any,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OSS upload failed: ${response.status} ${response.statusText} — ${errText.substring(0, 200)}`);
  }

  return sts.file_url;
}

// --- Step 3: Trigger server-side file parsing ---

async function parseFile(email: string, fileId: string): Promise<void> {
  const url = `${QWEN_API_BASE}/api/v2/files/parse`;
  const body = JSON.stringify({ file_id: fileId });

  const tokenInfo = await getTokenWithAccount(email);
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
  const response = await browserlessFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      cookie: cookieStr,
      origin: QWEN_API_BASE,
    },
    body,
    accountEmail: email,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`parseFile failed: ${response.status} — ${errText.substring(0, 200)}`);
  }
}

// --- Step 4: Poll parse status until complete ---

interface ParseStatusResponse {
  file_id: string;
  status: 'running' | 'success' | 'failed';
}

async function pollParseStatus(email: string, fileId: string, maxWaitMs = 5_000): Promise<void> {
  const url = `${QWEN_API_BASE}/api/v2/files/parse/status`;
  const startTime = Date.now();
  const pollInterval = 1_000;

  while (Date.now() - startTime < maxWaitMs) {
    const body = JSON.stringify({ file_id_list: [fileId] });

    const tokenInfo = await getTokenWithAccount(email);
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
    const response = await browserlessFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
      },
      body,
      accountEmail: email,
    });
    if (response.ok) {
      try {
        const resText = await response.text();
        const data = JSON.parse(resText);
        const status: string = data.data?.[0]?.status || data.status || '';
        if (status === 'success') {
          logStore.log('debug', 'upload', `[FileUpload] Parse complete for ${fileId} in ${Date.now() - startTime}ms`);
          return;
        }
        if (status === 'failed') throw new Error(`File parsing failed for ${fileId}`);
      } catch {
        // JSON parse error or missing field — keep polling
      }
    }

    await Bun.sleep(pollInterval);
  }

  logStore.log('warn', 'upload', `[FileUpload] Parse poll timed out after ${Date.now() - startTime}ms for ${fileId}`);
  // ponytail: file upload succeeded, parse may still finish async.
  // Qwen will include the file content once parsing completes on its side.
}

// --- Shared internal: upload arbitrary file content ---

/**
 * Upload arbitrary content (buffer) as a file to Qwen's file system.
 * Runs the full 4-step pipeline: STS token -> OSS upload -> parse trigger -> poll status.
 */
async function uploadFileContent(
  email: string,
  buffer: Buffer,
  fileName: string,
  contentType: string,
  fileClass: string,
  showType: string,
  filetype: string = 'file',
  attachmentType: string = 'file',
): Promise<QwenFileAttachment> {
  const fileSize = buffer.length;

  logStore.log('debug', 'upload', `[FileUpload] Uploading ${fileSize} bytes as "${fileName}" (${contentType}) for ${email}`);

  // Step 1: Get STS credentials
  const sts = await getstsToken(email, fileName, fileSize, filetype);
  logStore.log(
    'debug',
    'upload',
    `[FileUpload] Got STS token — bucket=${sts.bucketname}, file_id=${sts.file_id}, file_url=${sts.file_url}, endpoint=${sts.endpoint}, file_path=${sts.file_path}`,
  );

  // Step 2: Upload to OSS
  const fileUrl = await uploadToOss(sts, buffer, contentType);
  logStore.log('debug', 'upload', `[FileUpload] Uploaded to OSS — url=${fileUrl.substring(0, 80)}...`);

  // Images don't need server-side parsing — Qwen processes them directly from OSS
  if (attachmentType === 'file') {
    // Step 3: Trigger parsing
    await parseFile(email, sts.file_id);
    logStore.log('debug', 'upload', `[FileUpload] Parse triggered for ${sts.file_id}`);

    // Step 4: Poll until parsed
    await pollParseStatus(email, sts.file_id);
    logStore.log('debug', 'upload', `[FileUpload] Parse complete for ${sts.file_id}`);
  }

  return buildQwenFileAttachment(sts, fileName, fileSize, contentType, fileClass, showType, attachmentType);
}

// --- Orchestrator: upload large text as a Qwen file attachment ---

/**
 * Build the exact file attachment object matching Qwen web UI format.
 * Extracts user_id from file_path (format: "<user_id>/<file_id>_<filename>").
 */
function buildQwenFileAttachment(
  sts: StsTokenResponse,
  fileName: string,
  fileSize: number,
  contentType: string,
  fileClass: string,
  showType: string,
  attachmentType: string = 'file',
): QwenFileAttachment {
  // Extract user_id from file_path: "5309db52-.../370e7cdc-..._filename" → first segment
  const userId = sts.file_path.split('/')[0] || '';
  const now = Date.now();

  const meta: QwenFileAttachment['file']['meta'] = {
    name: fileName,
    size: fileSize,
    content_type: contentType,
    ...(attachmentType === 'file' ? { parse_meta: { parse_status: 'success' as const } } : {}),
  };

  return {
    type: attachmentType,
    file: {
      created_at: now,
      data: {},
      filename: fileName,
      hash: null,
      id: sts.file_id,
      user_id: userId,
      meta,
      update_at: now,
      lastModified: now,
      name: fileName,
      webkitRelativePath: '',
      size: fileSize,
      type: contentType,
    },
    id: sts.file_id,
    url: sts.file_url,
    name: fileName,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    greenNet: 'success',
    size: fileSize,
    error: '',
    itemId: crypto.randomUUID(),
    file_type: contentType,
    showType,
    file_class: fileClass,
    uploadTaskId: crypto.randomUUID(),
  };
}

export async function uploadLargeTextAsFile(email: string, text: string, fileName: string): Promise<QwenFileAttachment> {
  const encoder = new TextEncoder();
  const content = encoder.encode(text);
  const contentType = 'text/plain';
  return uploadFileContent(email, Buffer.from(content), fileName, contentType, 'document', 'file');
}

/**
 * Download an image (data URI or remote URL) and upload it to Qwen's file system.
 * Returns a QwenFileAttachment ready to attach to messages.
 */
export async function uploadImageAsFile(email: string, imageUrl: string): Promise<QwenFileAttachment> {
  let buffer: Buffer;
  let mimeType: string;
  let fileName: string;

  if (imageUrl.startsWith('data:')) {
    // Data URI: data:image/png;base64,iVBOR...
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URI format');
    mimeType = match[1];
    buffer = Buffer.from(match[2], 'base64');
    fileName = `image.${mimeType.split('/')[1] || 'png'}`;
  } else {
    // Remote URL — fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(imageUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = contentType;
      fileName = `image.${mimeType.split('/')[1] || 'png'}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Reject images over 10MB
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max 10MB)`);
  }

  return uploadFileContent(email, buffer, fileName, mimeType, 'vision', 'image', 'image', 'image');
}

/**
 * Download a video (data URI or remote URL) and upload it to Qwen's file system.
 * Returns a QwenFileAttachment ready to attach to messages.
 *
 * Format mirrors image uploads (aligned with Qwen web UI multimodal attachments):
 * - STS filetype = 'video'
 * - attachment type / showType = 'video'
 * - file_class = 'video'
 * - no server-side parse step (Qwen processes media directly from OSS)
 */
export async function uploadVideoAsFile(email: string, videoUrl: string): Promise<QwenFileAttachment> {
  let buffer: Buffer;
  let mimeType: string;
  let fileName: string;

  if (videoUrl.startsWith('data:')) {
    // Data URI: data:video/mp4;base64,...
    const match = videoUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URI format');
    mimeType = match[1];
    if (!mimeType.startsWith('video/')) {
      throw new Error(`Not a video data URI: ${mimeType}`);
    }
    buffer = Buffer.from(match[2], 'base64');
    fileName = `video.${mimeType.split('/')[1]?.split('+')[0] || 'mp4'}`;
  } else {
    // Remote URL — longer timeout than images (videos are larger)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(videoUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to download video: ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      // Accept pure video/* or content-type with parameters (e.g. video/mp4; codecs=...)
      const baseType = contentType.split(';')[0].trim().toLowerCase();
      if (!baseType.startsWith('video/')) {
        // Some CDNs omit content-type; fall back to extension sniffing
        const ext = videoUrl.split('?')[0].split('.').pop()?.toLowerCase() || '';
        const extMime: Record<string, string> = {
          mp4: 'video/mp4',
          webm: 'video/webm',
          mov: 'video/quicktime',
          mkv: 'video/x-matroska',
          avi: 'video/x-msvideo',
          mpeg: 'video/mpeg',
          mpg: 'video/mpeg',
        };
        if (!extMime[ext]) {
          throw new Error(`Not a video: ${contentType || 'unknown content-type'}`);
        }
        mimeType = extMime[ext];
      } else {
        mimeType = baseType;
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      fileName = `video.${mimeType.split('/')[1]?.split('+')[0] || 'mp4'}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Reject videos over 100MB (Qwen multimodal video limit)
  if (buffer.length > 100 * 1024 * 1024) {
    throw new Error(`Video too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max 100MB)`);
  }

  // Videos, like images, are multimodal media — skip document parse pipeline
  return uploadFileContent(email, buffer, fileName, mimeType, 'video', 'video', 'video', 'video');
}
