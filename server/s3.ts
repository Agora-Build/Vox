/**
 * S3-compatible storage helpers for generating signed URLs.
 *
 * Supports system-default config (env vars) and per-user overrides
 * (userStorageConfig table with encrypted credentials).
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage, decryptValue } from "./storage";

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

// ==================== THE USER'S OWN BUCKET (Tools → Analyze) ====================
// Uploaded recordings live only in the bucket the user set on the Storage page
// (design 2026-09-30): no system fallback, the audio is theirs.

export class NoUserStorageError extends Error {
  constructor() {
    super("Set up your storage first");
  }
}

/** The user's own bucket, or null when they haven't set one. */
export async function userBucket(userId: number): Promise<{ client: S3Client; bucket: string } | null> {
  const userConfig = await storage.getUserStorageConfig(userId);
  if (!userConfig) return null;
  const config: S3Config = {
    endpoint: userConfig.s3Endpoint,
    bucket: userConfig.s3Bucket,
    region: userConfig.s3Region,
    accessKeyId: decryptValue(userConfig.s3AccessKeyId),
    secretAccessKey: decryptValue(userConfig.s3SecretAccessKey),
  };
  return { client: createClient(config), bucket: config.bucket };
}

async function requireUserBucket(userId: number) {
  const b = await userBucket(userId);
  if (!b) throw new NoUserStorageError();
  return b;
}

export async function putUserObject(userId: number, key: string, body: Buffer, contentType: string): Promise<void> {
  const { client, bucket } = await requireUserBucket(userId);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getUserObjectStream(userId: number, key: string): Promise<{ body: Readable; contentLength?: number }> {
  const { client, bucket } = await requireUserBucket(userId);
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: out.Body as Readable, contentLength: out.ContentLength };
}

export async function deleteUserObject(userId: number, key: string): Promise<void> {
  const { client, bucket } = await requireUserBucket(userId);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
