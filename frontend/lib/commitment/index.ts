import {
  encodeAbiParameters,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";

// Must stay byte-for-byte aligned with SealedBatchAuction.ORDER_TYPEHASH.
export const ORDER_TYPEHASH = keccak256(
  toHex(
    "DarkswapOrder(uint256 chainId,address verifyingContract,address owner,uint256 batchId,uint8 side,address inputToken,uint256 amountIn,uint256 limitPriceX18,bytes32 salt)",
  ),
);

export type OrderSide = 0 | 1;

export interface CommitmentInput {
  chainId: bigint | number | string;
  verifyingContract: Address;
  owner: Address;
  batchId: bigint | number | string;
  side: OrderSide;
  inputToken: Address;
  amountIn: bigint | number | string;
  limitPriceX18: bigint | number | string;
  salt: Hex;
}

export type NewCommitmentInput = Omit<CommitmentInput, "salt">;

function uint(value: bigint | number | string, field: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error();
    }
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${field} must be an unsigned integer`);
  }
  if (parsed < 0n || parsed >= 1n << 256n) throw new RangeError(`${field} is outside uint256`);
  return parsed;
}

function validateAddress(value: string, field: string): asserts value is Address {
  if (!isAddress(value)) throw new TypeError(`${field} must be a valid address`);
}

function validateSalt(salt: string): asserts salt is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new TypeError("salt must be exactly bytes32");
}

/** Hashes the same static abi.encode tuple used by computeCommitment in Solidity. */
export function calculateCommitment(input: CommitmentInput): Hex {
  if (input.side !== 0 && input.side !== 1) throw new TypeError("side must be 0 (BUY) or 1 (SELL)");
  validateAddress(input.verifyingContract, "verifyingContract");
  validateAddress(input.owner, "owner");
  validateAddress(input.inputToken, "inputToken");
  validateSalt(input.salt);

  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      ORDER_TYPEHASH,
      uint(input.chainId, "chainId"),
      input.verifyingContract,
      input.owner,
      uint(input.batchId, "batchId"),
      input.side,
      input.inputToken,
      uint(input.amountIn, "amountIn"),
      uint(input.limitPriceX18, "limitPriceX18"),
      input.salt,
    ],
  );
  return keccak256(encoded);
}

/** Generates a fresh 256-bit salt using the browser's cryptographic RNG. */
export function generateSalt(): Hex {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("A cryptographic random number generator is unavailable");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export function createCommitment(input: NewCommitmentInput): { salt: Hex; commitment: Hex } {
  const salt = generateSalt();
  return { salt, commitment: calculateCommitment({ ...input, salt }) };
}
