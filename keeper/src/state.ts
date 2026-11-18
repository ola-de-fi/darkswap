import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProcessingStatus =
  | "observed"
  | "simulated"
  | "pending"
  | "confirmed"
  | "failed"
  | "expired";

export type BatchRecord = {
  batchId: string;
  status: ProcessingStatus;
  transactionHash?: `0x${string}`;
  /** Signed settlement bytes and nonce, kept so a dropped broadcast can be re-sent unchanged. */
  serializedTransaction?: `0x${string}`;
  nonce?: number;
  confirmationStatus?: "pending" | "confirmed" | "reverted";
  lastCheckedBlock: string;
  updatedAt: string;
  note?: string;
};

export type KeeperState = {
  version: 1;
  batches: Record<string, BatchRecord>;
  lastCheckedBlock: string;
};

const DEFAULT_STATE_FILE = fileURLToPath(new URL("../data/state.json", import.meta.url));
const statePath = (value?: string): string => resolve(value ?? DEFAULT_STATE_FILE);
const emptyState = (): KeeperState => ({ version: 1, batches: {}, lastCheckedBlock: "0" });

export async function loadState(filePath = process.env.KEEPER_STATE_FILE): Promise<KeeperState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(filePath), "utf8")) as Partial<KeeperState>;
    if (parsed.version !== 1 || typeof parsed.batches !== "object" || parsed.batches === null) return emptyState();
    return {
      version: 1,
      batches: parsed.batches as Record<string, BatchRecord>,
      lastCheckedBlock: typeof parsed.lastCheckedBlock === "string" ? parsed.lastCheckedBlock : "0",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(
  state: KeeperState,
  filePath = process.env.KEEPER_STATE_FILE,
): Promise<void> {
  const destination = statePath(filePath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export function updateBatchRecord(
  state: KeeperState,
  batchId: bigint,
  patch: Omit<Partial<BatchRecord>, "batchId" | "updatedAt">,
): KeeperState {
  const key = batchId.toString();
  const old = state.batches[key];
  state.batches[key] = {
    batchId: key,
    status: patch.status ?? old?.status ?? "observed",
    lastCheckedBlock: patch.lastCheckedBlock ?? old?.lastCheckedBlock ?? "0",
    updatedAt: new Date().toISOString(),
    ...(old?.transactionHash ? { transactionHash: old.transactionHash } : {}),
    ...(old?.serializedTransaction ? { serializedTransaction: old.serializedTransaction } : {}),
    ...(old?.nonce !== undefined ? { nonce: old.nonce } : {}),
    ...(old?.confirmationStatus ? { confirmationStatus: old.confirmationStatus } : {}),
    ...(old?.note ? { note: old.note } : {}),
    ...patch,
  };
  return state;
}
