export interface CategoryStat {
  category: string;
  label: string;
  color: string;
  objectCount: number;
  sizeBytes: number;
  percent: number;
}

export interface SystemStats {
  bucketCount: number;
  publicBucketCount: number;
  privateBucketCount: number;
  objectCount: number;
  folderCount: number;
  blobCount: number;
  logicalBytes: number;
  physicalBytes: number;
  savedBytes: number;
  dedupRatioPercent: number;
  avgRefCount: number;
  accessKeyCount: number;
  multipartActiveCount: number;
  categories: CategoryStat[];
  recentObjects: StorageObject[];
  topObjects: StorageObject[];
  uptimeSeconds: number;
}

export interface Bucket {
  name: string;
  visibility: 'private' | 'public-read';
  quotaBytes: number;
  corsOrigins: string;
  createdAt: string;
  objectCount: number;
  usedBytes: number;
}

export interface StorageObject {
  id: number;
  bucket: string;
  key: string;
  name: string;
  parentDir: string;
  isFolder: boolean;
  blobSha256?: string;
  sizeBytes: number;
  contentType: string;
  etag: string;
  customMeta?: Record<string, string>;
  updatedAt: string;
}

export interface DirectoryListing {
  bucket: string;
  prefix: string;
  breadcrumbs: string[];
  items: StorageObject[];
  totalCount: number;
}

export interface AccessKeyItem {
  accessKey: string;
  secretKey: string;
  name: string;
  allowedBuckets: string;
  permission: 'read' | 'readwrite' | 'admin';
  createdAt: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
  isAdmin: boolean;
  username: string;
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
}

export interface MultipartPartInfo {
  uploadId: string;
  partNumber: number;
  sizeBytes: number;
  etag: string;
  uploadedAt: string;
}

export interface MultipartStatusResponse {
  uploadId: string;
  bucket: string;
  key: string;
  contentType: string;
  createdAt: string;
  parts: MultipartPartInfo[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (
    options.body &&
    typeof options.body === 'object' &&
    !(options.body instanceof FormData) &&
    !(options.body instanceof Blob)
  ) {
    headers['Content-Type'] = 'application/json';
  }

  const resp = await fetch(path, {
    ...options,
    headers,
  });

  const data = await resp.json().catch(() => ({}));
  if (
    resp.status === 401 &&
    path !== '/api/v1/auth/login' &&
    path !== '/api/v1/auth/account'
  ) {
    if (typeof window !== 'undefined' && path !== '/api/v1/auth/me') {
      window.dispatchEvent(new Event('cos:unauthorized'));
    }
    throw new Error('UNAUTHORIZED');
  }
  if (!resp.ok) {
    throw new Error(data.error || `请求失败 (${resp.status})`);
  }
  return data as T;
}

export const cosApi = {
  me: () => request<AuthMeResponse>('/api/v1/auth/me'),

  login: (username: string, password: string) =>
    request<{ token: string; username: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  updateAccount: (payload: {
    currentPassword: string;
    newUsername: string;
    newPassword: string;
  }) =>
    request<{ ok: boolean; username: string; token: string }>(
      '/api/v1/auth/account',
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    ),

  logout: () =>
    request<{ ok: boolean }>('/api/v1/auth/logout', {
      method: 'POST',
    }),

  getStats: () =>
    request<{
      stats: SystemStats;
      baseUrl: string;
      s3Endpoint: string;
      s3Region: string;
    }>('/api/v1/stats'),

  listBuckets: () => request<{ buckets: Bucket[] }>('/api/v1/buckets'),

  createBucket: (payload: {
    name: string;
    visibility: string;
    quotaBytes: number;
    corsOrigins: string;
  }) =>
    request<{ bucket: Bucket }>('/api/v1/buckets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateBucket: (
    name: string,
    payload: { visibility: string; quotaBytes: number; corsOrigins: string }
  ) =>
    request<{ bucket: Bucket }>(`/api/v1/buckets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteBucket: (name: string, force = true) =>
    request<{ ok: boolean }>(
      `/api/v1/buckets/${encodeURIComponent(name)}?force=${force ? 'true' : 'false'}`,
      { method: 'DELETE' }
    ),

  browseObjects: (
    bucket: string,
    prefix = '',
    search = '',
    limit = 50,
    offset = 0
  ) => {
    const q = new URLSearchParams({
      prefix,
      search,
      limit: String(limit),
      offset: String(offset),
    });
    return request<DirectoryListing>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/objects?${q.toString()}`
    );
  },

  createFolder: (bucket: string, key: string) =>
    request<{ folder: StorageObject }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/folders`,
      {
        method: 'POST',
        body: JSON.stringify({ key }),
      }
    ),

  tryFastUpload: (
    bucket: string,
    payload: { key: string; sha256: string; contentType: string }
  ) =>
    request<{ fastUploaded: boolean; object?: StorageObject; url?: string }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/fast-upload`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  copyObject: (
    srcBucket: string,
    payload: {
      srcKey: string;
      dstBucket: string;
      dstKey: string;
      deleteSource: boolean;
    }
  ) =>
    request<{ object: StorageObject; url: string }>(
      `/api/v1/buckets/${encodeURIComponent(srcBucket)}/copy`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  deleteObject: (bucket: string, key: string) =>
    request<{ deletedCount: number }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/objects?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    ),

  presignUrl: (
    bucket: string,
    payload: {
      key: string;
      method: 'GET' | 'PUT';
      expiresInSec: number;
      download?: boolean;
    }
  ) =>
    request<{ url: string; method: string; expiresAt: string }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/presign`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  initMultipart: (bucket: string, key: string, contentType: string) =>
    request<{ uploadId: string }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/multipart/init`,
      {
        method: 'POST',
        body: JSON.stringify({ key, contentType }),
      }
    ),

  getMultipartStatus: (bucket: string, uploadId: string) =>
    request<MultipartStatusResponse>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/multipart/${encodeURIComponent(uploadId)}`
    ),

  uploadMultipartPart: async (
    bucket: string,
    uploadId: string,
    partNumber: number,
    chunk: Blob,
    signal?: AbortSignal
  ) => {
    const resp = await fetch(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/multipart/${encodeURIComponent(uploadId)}/${partNumber}`,
      {
        method: 'PUT',
        body: chunk,
        signal,
      }
    );
    if (resp.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('cos:unauthorized'));
      throw new Error('UNAUTHORIZED');
    }
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `分片 #${partNumber} 上传失败 (${resp.status})`);
    }
    return resp.json().catch(() => ({}));
  },

  completeMultipart: (bucket: string, uploadId: string) =>
    request<{ object: StorageObject; url: string }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/multipart/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST' }
    ),

  abortMultipart: (bucket: string, uploadId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/buckets/${encodeURIComponent(bucket)}/multipart/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ),

  listAccessKeys: () =>
    request<{ accessKeys: AccessKeyItem[] }>('/api/v1/access-keys'),

  createAccessKey: (payload: {
    name: string;
    allowedBuckets: string;
    permission: string;
  }) =>
    request<{ accessKey: AccessKeyItem }>('/api/v1/access-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteAccessKey: (ak: string) =>
    request<{ ok: boolean }>(`/api/v1/access-keys/${encodeURIComponent(ak)}`, {
      method: 'DELETE',
    }),
};
