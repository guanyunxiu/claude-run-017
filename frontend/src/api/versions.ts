import { api, ApiError } from './client';

export interface FileVersionSummary {
  version: number;
  createdAt: string;
  sizeBytes: number;
}

export interface FileVersionPreview {
  version: number;
  createdAt: string;
  content: string;
  language: string;
}

export interface VersionListResponse {
  fileId: string;
  versions: FileVersionSummary[];
}

export interface RestoreResponse {
  fileId: string;
  version: number;
}

export async function listFileVersions(fileId: string) {
  return api.get<VersionListResponse>(`/files/${fileId}/versions`);
}

export async function previewFileVersion(fileId: string, version: number) {
  return api.get<FileVersionPreview>(
    `/files/${fileId}/versions/${version}/preview`,
  );
}

export async function restoreFileVersion(fileId: string, version: number) {
  return api.post<RestoreResponse>(
    `/files/${fileId}/versions/${version}/restore`,
  );
}

export { ApiError };
