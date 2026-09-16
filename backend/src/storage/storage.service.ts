import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Object storage abstraction backed by S3 / MinIO.
 *
 * In phase 1 it stores full Yjs document snapshots:
 *   s3://<bucket>/snapshots/<fileId>/v<version>-<timestamp>.bin
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT');
    const region = config.get<string>('S3_REGION', 'us-east-1');
    this.bucket = config.get<string>('S3_BUCKET', 'collab-snapshots');
    const forcePathStyle =
      config.get<string>('S3_FORCE_PATH_STYLE', 'true') !== 'false';

    this.client = new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle,
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY_ID', 'minioadmin'),
        secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY', 'minioadmin'),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // Bucket is normally created by the minio-init sidecar / Terraform.
    // Verify reachability but do not crash the process if MinIO is briefly down.
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Object storage bucket ready: ${this.bucket}`);
    } catch (err) {
      this.logger.warn(
        `Object storage bucket "${this.bucket}" not reachable yet: ${(err as Error).message}`,
      );
    }
  }

  snapshotKey(fileId: string, version: number): string {
    return `snapshots/${fileId}/v${version}-${Date.now()}.bin`;
  }

  async putSnapshot(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes as Uint8Array<ArrayBufferLike>,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async getSnapshot(key: string): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`Empty snapshot body for key ${key}`);
    }
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  async deleteSnapshot(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
