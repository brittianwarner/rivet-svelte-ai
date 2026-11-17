/**
 * Where app files live: exports, uploads, anything too large for actor state.
 *
 * Production uses the api service's own bucket (FILES_*), separate from the
 * engine's. Actors keep small records (who, what, when) in their own SQLite
 * and the bytes here, so an actor stays small no matter how many files it
 * owns, and a file outlives the replica that wrote it.
 *
 * Development uses a directory (`.rivet/files`), so `bun run dev` needs no
 * bucket. Tests use memory. All three behave the same: keys are paths of
 * `[A-Za-z0-9._-]` segments, reads stream, deletes are idempotent.
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StoredFile {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
}

export interface PutOptions {
  contentType: string;
}

export interface FileStore {
  readonly kind: "s3" | "disk" | "memory";
  put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<void>;
  /** Null when there is no file at `key`. */
  get(key: string): Promise<StoredFile | null>;
  /** Succeeds when the file is already gone. */
  delete(key: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** Throws on anything that could escape the store's root. */
export function assertFileKey(key: string): string {
  const parts = key.split("/");
  if (
    parts.length > 16 ||
    parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")
  ) {
    throw new Error(`Invalid file key: ${JSON.stringify(key.slice(0, 80))}`);
  }
  return key;
}

function bytesOf(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

export interface S3FileSettings {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix, e.g. `files/`. */
  prefix: string;
  virtualHostedStyle: boolean;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string; name?: string } | null)?.code;
  return (
    code === "NoSuchKey" ||
    code === "ERR_S3_FILE_NOT_FOUND" ||
    code === "NotFound"
  );
}

/**
 * Bun's client sends virtual-hosted requests to the endpoint as given, so the
 * endpoint must already carry the bucket host (`<bucket>.storage.example`).
 * Railway buckets are virtual-hosted; MinIO is path-style by default.
 */
export function bucketEndpoint(
  settings: Pick<S3FileSettings, "bucket" | "endpoint" | "virtualHostedStyle">,
): string {
  const url = new URL(settings.endpoint);
  if (
    settings.virtualHostedStyle &&
    !url.hostname.startsWith(`${settings.bucket}.`)
  )
    url.hostname = `${settings.bucket}.${url.hostname}`;
  return url.origin;
}

export function s3FileStore(settings: S3FileSettings): FileStore {
  const client = new Bun.S3Client({
    bucket: settings.bucket,
    endpoint: bucketEndpoint(settings),
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    virtualHostedStyle: settings.virtualHostedStyle,
  });
  const path = (key: string) => settings.prefix + assertFileKey(key);
  return {
    kind: "s3",
    async put(key, body, opts) {
      await client.write(path(key), bytesOf(body), { type: opts.contentType });
    },
    async get(key) {
      const file = client.file(path(key));
      try {
        const stat = await file.stat();
        return {
          body: file.stream(),
          size: stat.size,
          contentType: stat.type || "application/octet-stream",
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      try {
        await client.delete(path(key));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}

/** One file per key plus a `.type` sidecar holding its content type. */
export function diskFileStore(root: string): FileStore {
  const path = (key: string) => join(root, assertFileKey(key));
  return {
    kind: "disk",
    async put(key, body, opts) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      await Bun.write(temp, bytesOf(body));
      await Bun.write(`${target}.type`, opts.contentType);
      await rename(temp, target);
    },
    async get(key) {
      const file = Bun.file(path(key));
      if (!(await file.exists())) return null;
      const type = Bun.file(`${path(key)}.type`);
      return {
        body: file.stream(),
        size: file.size,
        contentType: (await type.exists())
          ? (await type.text()).trim()
          : "application/octet-stream",
      };
    },
    async delete(key) {
      await rm(path(key), { force: true });
      await rm(`${path(key)}.type`, { force: true });
    },
  };
}

export function memoryFileStore(): FileStore {
  const files = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; contentType: string }
  >();
  return {
    kind: "memory",
    async put(key, body, opts) {
      files.set(assertFileKey(key), {
        body: new Uint8Array(bytesOf(body)),
        contentType: opts.contentType,
      });
    },
    async get(key) {
      const file = files.get(assertFileKey(key));
      if (!file) return null;
      return {
        body: new Blob([file.body]).stream(),
        size: file.body.byteLength,
        contentType: file.contentType,
      };
    },
    async delete(key) {
      files.delete(assertFileKey(key));
    },
  };
}

export type FileStoreConfig =
  { kind: "s3"; settings: S3FileSettings } | { kind: "disk"; root: string };

/**
 * FILES_BUCKET (with FILES_ENDPOINT, FILES_ACCESS_KEY_ID and
 * FILES_SECRET_ACCESS_KEY) selects the bucket. Without it, files go to
 * FILES_DIR, or `<repo>/.rivet/files`. Production must name one or the other:
 * a container's own disk does not survive a deploy.
 */
export function fileStoreConfig(
  env: Record<string, string | undefined> = process.env,
): FileStoreConfig {
  const bucket = env.FILES_BUCKET?.trim();
  if (bucket) {
    const required = [
      "FILES_ENDPOINT",
      "FILES_ACCESS_KEY_ID",
      "FILES_SECRET_ACCESS_KEY",
    ] as const;
    const missing = required.filter((key) => !env[key]?.trim());
    if (missing.length > 0)
      throw new Error(`FILES_BUCKET is set; also set ${missing.join(", ")}.`);
    const prefix = env.FILES_PREFIX?.trim() ?? "";
    return {
      kind: "s3",
      settings: {
        bucket,
        endpoint: env.FILES_ENDPOINT!.trim().replace(/\/+$/, ""),
        region: env.FILES_REGION?.trim() || "auto",
        accessKeyId: env.FILES_ACCESS_KEY_ID!.trim(),
        secretAccessKey: env.FILES_SECRET_ACCESS_KEY!.trim(),
        prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
        virtualHostedStyle: (env.FILES_VIRTUAL_HOSTED ?? "true") !== "false",
      },
    };
  }
  const dir = env.FILES_DIR?.trim();
  if (!dir && env.NODE_ENV === "production") {
    throw new Error(
      "Set FILES_BUCKET (the api's bucket) or FILES_DIR. Container disks do not survive deploys.",
    );
  }
  return {
    kind: "disk",
    root:
      dir || fileURLToPath(new URL("../../../.rivet/files", import.meta.url)),
  };
}

export function createFileStore(config: FileStoreConfig): FileStore {
  return config.kind === "s3"
    ? s3FileStore(config.settings)
    : diskFileStore(config.root);
}
