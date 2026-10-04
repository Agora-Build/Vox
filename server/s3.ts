/**
 * S3-compatible storage helpers for generating signed URLs.
 *
 * Supports system-default config (env vars) and per-user overrides
 * (userStorageConfig table with encrypted credentials).
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { checkStorageEndpoint, guardedRequestHandler } from "./storage-endpoint";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage, decryptValue } from "./storage";
import type { ArtifactObject } from "./artifact-preview";

const DEFAULT_EXPIRES_IN = 3600; // 1 hour

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function getSystemS3Config(): S3Config | null {
  const endpoint = process.env["S3_ENDPOINT"];
  const bucket = process.env["S3_BUCKET"];
  const accessKeyId = process.env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"];

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    endpoint,
    bucket,
    region: process.env["S3_REGION"] || "auto",
    accessKeyId,
    secretAccessKey,
  };
}

function createClient(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Generate a signed URL for an S3 key using system config.
 * Returns null if S3 is not configured.
 */
export async function generateSignedUrl(
  key: string,
  expiresIn: number = DEFAULT_EXPIRES_IN,
): Promise<string | null> {
  const config = getSystemS3Config();
  if (!config) return null;

  const client = createClient(config);
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate a signed URL, checking for per-user S3 override first.
 * Falls back to system config if user has no custom storage.
 */
export async function generateSignedUrlForUser(
  userId: number,
  key: string,
  expiresIn: number = DEFAULT_EXPIRES_IN,
): Promise<string | null> {
  // Check user override
  const userConfig = await storage.getUserStorageConfig(userId);
  if (userConfig) {
    try {
      const config: S3Config = {
        endpoint: userConfig.s3Endpoint,
        bucket: userConfig.s3Bucket,
        region: userConfig.s3Region,
        accessKeyId: decryptValue(userConfig.s3AccessKeyId),
        secretAccessKey: decryptValue(userConfig.s3SecretAccessKey),
      };
      const client = createClient(config);
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      return getSignedUrl(client, command, { expiresIn });
    } catch (e) {
      console.error(`[S3] Failed to generate signed URL with user config for user ${userId}:`, e);
    }
  }

  // Fall back to system
  return generateSignedUrl(key, expiresIn);
}

/**
 * Check if S3 is configured (system-level).
 */
export function isS3Configured(): boolean {
  return getSystemS3Config() !== null;
}

/** Stream a stored job artifact. Unlike signing, this connects from Core. */
export async function getArtifactObjectStream(userId: number, key: string, signal: AbortSignal): Promise<ArtifactObject> {
  const userConfig = await storage.getUserStorageConfig(userId);
  let client: S3Client;
  let bucket: string;
  if (userConfig) {
    checkStorageEndpoint(userConfig.s3Endpoint);
    bucket = userConfig.s3Bucket;
    client = new S3Client({
      endpoint: userConfig.s3Endpoint, region: userConfig.s3Region, forcePathStyle: true,
      credentials: { accessKeyId: decryptValue(userConfig.s3AccessKeyId), secretAccessKey: decryptValue(userConfig.s3SecretAccessKey) },
      requestHandler: guardedRequestHandler(),
    });
  } else {
    const config = getSystemS3Config();
    if (!config) throw new Error("Artifact storage is not configured");
    bucket = config.bucket;
    client = createClient(config);
  }
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
    const body = out.Body as Readable | undefined;
    if (!body) throw new Error("Artifact storage returned no data");
    return { body, contentLength: out.ContentLength, contentEncoding: out.ContentEncoding, close: () => { body.destroy(); client.destroy(); } };
  } catch (error) { client.destroy(); throw error; }
}

// ==================== THE USER'S OWN BUCKET (Tools → Analyze) ====================
// Uploaded recordings live only in the bucket the user set on the Storage page
// (design 2026-09-30): no system fallback, the audio is theirs. Core connects
// to that endpoint itself here, so the endpoint is checked and every
// connection is guarded (server/storage-endpoint.ts).

/** One resolved view of a user's bucket: check it and use it together. */
export interface UserBucket {
  client: S3Client;
  bucket: string;
  endpoint: string;
}

/**
 * The user's own bucket, or null when they haven't set one. Throws when Core
 * may not connect to its endpoint (not public HTTPS).
 */
export async function userBucket(userId: number): Promise<UserBucket | null> {
  const userConfig = await storage.getUserStorageConfig(userId);
  if (!userConfig) return null;
  checkStorageEndpoint(userConfig.s3Endpoint);
  const client = new S3Client({
    endpoint: userConfig.s3Endpoint,
    region: userConfig.s3Region,
    credentials: {
      accessKeyId: decryptValue(userConfig.s3AccessKeyId),
      secretAccessKey: decryptValue(userConfig.s3SecretAccessKey),
    },
    forcePathStyle: true,
    requestHandler: guardedRequestHandler(),
  });
  return { client, bucket: userConfig.s3Bucket, endpoint: userConfig.s3Endpoint };
}

export async function putObject(b: UserBucket, key: string, body: Buffer, contentType: string): Promise<void> {
  await b.client.send(new PutObjectCommand({ Bucket: b.bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectStream(b: UserBucket, key: string): Promise<{ body: Readable; contentLength?: number }> {
  const out = await b.client.send(new GetObjectCommand({ Bucket: b.bucket, Key: key }));
  return { body: out.Body as Readable, contentLength: out.ContentLength };
}

export async function deleteObject(b: UserBucket, key: string): Promise<void> {
  await b.client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: key }));
}
