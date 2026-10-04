import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getArtifactObjectStream } from "../server/s3";

const mocks = vi.hoisted(() => ({
  userConfig: vi.fn(), decrypt: vi.fn((value: string) => `decoded-${value}`),
  clientOptions: vi.fn(), send: vi.fn(), destroy: vi.fn(),
  guarded: { task: "guarded-request-handler" },
}));
vi.mock("../server/storage", () => ({ storage: { getUserStorageConfig: mocks.userConfig }, decryptValue: mocks.decrypt }));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class {
    constructor(options: unknown) { mocks.clientOptions(options); }
    send = mocks.send;
    destroy = mocks.destroy;
  },
}));
vi.mock("../server/storage-endpoint", async (original) => ({
  ...await original<typeof import("../server/storage-endpoint")>(),
  guardedRequestHandler: () => mocks.guarded,
}));

describe("artifact preview storage access", () => {
  const key = "jobs/35360/recordings/recording.webm";
  const configuration = { s3Endpoint: "https://storage.example.test", s3Bucket: "personal-bucket", s3Region: "auto", s3AccessKeyId: "fixture-id", s3SecretAccessKey: "fixture-secret" };
  beforeEach(() => {
    vi.clearAllMocks(); mocks.userConfig.mockResolvedValue(undefined);
    vi.stubEnv("VOX_STORAGE_ALLOW_PRIVATE", "");
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());
  const systemStorage = () => {
    vi.stubEnv("S3_ENDPOINT", "https://system.example.test"); vi.stubEnv("S3_BUCKET", "system-bucket");
    vi.stubEnv("S3_ACCESS_KEY_ID", "fixture-system-id"); vi.stubEnv("S3_SECRET_ACCESS_KEY", "fixture-system-secret");
  };
  it("uses the owner's override with guarded DNS connections and propagates cancellation", async () => {
    mocks.userConfig.mockResolvedValue(configuration);
    const body = Readable.from([Buffer.from("fixture")]);
    const closeBody = vi.spyOn(body, "destroy");
    mocks.send.mockResolvedValue({ Body: body, ContentLength: 7, ContentEncoding: "gzip" });
    const controller = new AbortController();
    const object = await getArtifactObjectStream(7, key, controller.signal);
    expect(mocks.userConfig).toHaveBeenCalledWith(7);
    expect(mocks.clientOptions).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: configuration.s3Endpoint, requestHandler: mocks.guarded, forcePathStyle: true,
    }));
    const [command, options] = mocks.send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: "personal-bucket", Key: key });
    expect(options).toEqual({ abortSignal: controller.signal });
    expect(object.contentLength).toBe(7); expect(object.contentEncoding).toBe("gzip");
    object.close();
    expect(closeBody).toHaveBeenCalled(); expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("uses trusted system storage only when there is no user override", async () => {
    systemStorage();
    mocks.send.mockResolvedValue({ Body: Readable.from([]) });
    const object = await getArtifactObjectStream(7, key, new AbortController().signal);
    expect(mocks.clientOptions).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://system.example.test" }));
    expect(mocks.send.mock.calls[0][0].input.Bucket).toBe("system-bucket");
    object.close();
  });
  it("refuses private user endpoints without connecting or falling back to system storage", async () => {
    systemStorage();
    for (const s3Endpoint of ["https://127.0.0.1", "http://storage.example.test", "https://169.254.169.254"]) {
      mocks.userConfig.mockResolvedValue({ ...configuration, s3Endpoint });
      await expect(getArtifactObjectStream(7, key, new AbortController().signal)).rejects.toThrow();
    }
    expect(mocks.clientOptions).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("closes a failed user client and never falls back to another bucket", async () => {
    systemStorage(); mocks.userConfig.mockResolvedValue(configuration);
    mocks.send.mockRejectedValue(new Error("fixture-storage-error"));
    await expect(getArtifactObjectStream(7, key, new AbortController().signal)).rejects.toThrow("fixture-storage-error");
    expect(mocks.clientOptions).toHaveBeenCalledOnce(); expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("closes a client when the storage response has no readable body", async () => {
    systemStorage(); mocks.send.mockResolvedValue({});
    await expect(getArtifactObjectStream(7, key, new AbortController().signal)).rejects.toThrow("no data");
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("fails closed when neither bucket is configured", async () => {
    await expect(getArtifactObjectStream(7, key, new AbortController().signal)).rejects.toThrow("not configured");
    expect(mocks.clientOptions).not.toHaveBeenCalled();
  });
});
