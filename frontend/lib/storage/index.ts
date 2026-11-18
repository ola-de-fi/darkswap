import { getAddress, isAddress, type Address, type Hex } from "viem";
import { calculateCommitment, type CommitmentInput, type OrderSide } from "../commitment";

const DB_NAME = "darkswap-order-secrets";
const DB_VERSION = 1;
const STORE_NAME = "orders";
const BACKUP_FORMAT = "darkswap-order-secret";
const BACKUP_VERSION = 1;

export interface SecretScope {
  chainId: string;
  verifyingContract: Address;
  owner: Address;
  batchId: string;
}

export interface OrderSecret extends SecretScope {
  side: OrderSide;
  inputToken: Address;
  amountIn: string;
  limitPriceX18: string;
  salt: Hex;
  commitment: Hex;
}

const secretFields = [
  "chainId", "verifyingContract", "owner", "batchId", "side", "inputToken",
  "amountIn", "limitPriceX18", "salt", "commitment",
].sort();

function hasExactFields(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === expected.join("\0");
}

function canonicalUint(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${field} must be a canonical unsigned integer string`);
  }
  if (BigInt(value) >= 1n << 256n) throw new RangeError(`${field} is outside uint256`);
  return value;
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new TypeError(`${field} must be a valid address`);
  return getAddress(value);
}

function validateSecret(value: unknown): OrderSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid order secret");
  const data = value as Record<string, unknown>;
  if (!hasExactFields(data, secretFields)) throw new TypeError("Order secret has missing or unexpected fields");
  if (data.side !== 0 && data.side !== 1) throw new TypeError("side must be 0 (BUY) or 1 (SELL)");
  if (typeof data.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data.salt)) throw new TypeError("salt must be exactly bytes32");
  if (typeof data.commitment !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data.commitment)) throw new TypeError("commitment must be exactly bytes32");

  const secret: OrderSecret = {
    chainId: canonicalUint(data.chainId, "chainId"),
    verifyingContract: canonicalAddress(data.verifyingContract, "verifyingContract"),
    owner: canonicalAddress(data.owner, "owner"),
    batchId: canonicalUint(data.batchId, "batchId"),
    side: data.side,
    inputToken: canonicalAddress(data.inputToken, "inputToken"),
    amountIn: canonicalUint(data.amountIn, "amountIn"),
    limitPriceX18: canonicalUint(data.limitPriceX18, "limitPriceX18"),
    salt: data.salt as Hex,
    commitment: data.commitment as Hex,
  };
  const calculated = calculateCommitment(secret as CommitmentInput);
  if (calculated.toLowerCase() !== secret.commitment.toLowerCase()) {
    throw new TypeError("Order secret commitment does not match its fields and salt");
  }
  return secret;
}

function scopeKey(scope: SecretScope): string {
  const chainId = canonicalUint(scope.chainId, "chainId");
  const batchId = canonicalUint(scope.batchId, "batchId");
  const verifyingContract = canonicalAddress(scope.verifyingContract, "verifyingContract").toLowerCase();
  const owner = canonicalAddress(scope.owner, "owner").toLowerCase();
  return [chainId, verifyingContract, owner, batchId].join(":");
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this environment"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local order storage"));
    request.onblocked = () => reject(new Error("Local order storage upgrade is blocked"));
  });
}

function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    let result: T | undefined;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("Local order storage operation failed"));
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Local order storage transaction aborted"));
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result as T);
    };
    tx.onerror = () => db.close();
  }));
}

/** Stores reveal material only in this browser's IndexedDB. Data is not encrypted. */
export async function saveOrderSecret(secret: OrderSecret): Promise<void> {
  const valid = validateSecret(secret);
  const key = scopeKey(valid);
  await transact("readwrite", (store) => store.put({ key, secret: valid }));
}

/** Reads the locally saved secret for this chain/auction/wallet/batch scope. */
export async function loadOrderSecret(scope: SecretScope): Promise<OrderSecret | undefined> {
  const entry = await transact<{ key: string; secret: unknown } | undefined>("readonly", (store) => store.get(scopeKey(scope)));
  if (!entry) return undefined;
  return validateSecret(entry.secret);
}

export async function deleteOrderSecret(scope: SecretScope): Promise<void> {
  await transact("readwrite", (store) => store.delete(scopeKey(scope)));
}

/** Produces a portable plaintext JSON backup after validating its commitment. */
export function exportOrderSecret(secret: OrderSecret): string {
  const valid = validateSecret(secret);
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, order: valid }, null, 2);
}

/** Strictly imports a backup and requires it to match the caller's expected scope. */
export function importOrderSecret(json: string, expectedScope: SecretScope): OrderSecret {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new TypeError("Backup is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Invalid backup document");
  const backup = parsed as Record<string, unknown>;
  if (!hasExactFields(backup, ["format", "version", "order"].sort())) throw new TypeError("Backup has missing or unexpected fields");
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) throw new TypeError("Unsupported backup format or version");
  const secret = validateSecret(backup.order);
  if (scopeKey(secret) !== scopeKey(expectedScope)) throw new TypeError("Backup does not match the expected chain, auction, wallet, and batch");
  return secret;
}
