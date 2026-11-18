import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadState, saveState, updateBatchRecord } from "../src/state.js";

let directory = "";

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("persistent keeper state", () => {
  it("round-trips pending transactions and last checked block atomically", async () => {
    directory = await mkdtemp(join(tmpdir(), "darkswap-keeper-"));
    const file = join(directory, "state.json");
    const state = await loadState(file);
    state.lastCheckedBlock = "120";
    updateBatchRecord(state, 7n, {
      status: "pending",
      transactionHash: `0x${"ab".repeat(32)}`,
      confirmationStatus: "pending",
      lastCheckedBlock: "120",
    });
    await saveState(state, file);
    const recovered = await loadState(file);
    expect(recovered.lastCheckedBlock).toBe("120");
    expect(recovered.batches["7"]?.status).toBe("pending");
    expect(recovered.batches["7"]?.transactionHash).toBe(`0x${"ab".repeat(32)}`);
    expect(await readFile(file, "utf8")).toContain('"confirmationStatus": "pending"');
  });
});
