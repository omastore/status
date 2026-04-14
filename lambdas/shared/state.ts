import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { emptyState, State } from './types';

const BUCKET = process.env.STATE_BUCKET!;
const KEY = 'state.json';

const s3 = new S3Client({});

interface Loaded {
  state: State;
  etag: string | undefined;
}

async function load(): Promise<Loaded> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
    const body = await res.Body!.transformToString();
    const state = JSON.parse(body) as State;
    return { state, etag: res.ETag };
  } catch (err) {
    if (err instanceof S3ServiceException && (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)) {
      return { state: emptyState(), etag: undefined };
    }
    throw err;
  }
}

async function save(state: State, etag: string | undefined): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: 'application/json',
      CacheControl: 'no-store, max-age=0',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
    })
  );
}

const MAX_ATTEMPTS = 5;

export async function readModifyWriteState<T>(mutator: (state: State) => T | Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { state, etag } = await load();
    const result = await mutator(state);
    try {
      await save(state, etag);
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof S3ServiceException) {
        const code = err.$metadata.httpStatusCode;
        if (code === 412 || code === 409) {
          await sleep(50 + Math.random() * 150 * (attempt + 1));
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error(`readModifyWriteState: exhausted ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}

export async function readState(): Promise<State> {
  return (await load()).state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
