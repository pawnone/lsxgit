import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./storage.mjs";

// Read the original v0.3.1 location and append-only attempts. Never delete receipts.
export async function taskRecords(baseDir, inputHash) {
  const dirs = [baseDir];
  for (const e of await fs
    .readdir(path.join(baseDir, "attempts"), { withFileTypes: true })
    .catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    }))
    if (e.isDirectory()) dirs.push(path.join(baseDir, "attempts", e.name));
  const records = [];
  for (const dir of dirs) {
    const receiptFile = path.join(dir, `draft-save-${inputHash}.json`),
      receipt = await readJson(receiptFile),
      intent = await readJson(path.join(dir, "intent.json"));
    if (!receipt && !intent) continue;
    const confirmed =
      receipt?.status === "confirmed" &&
      receipt.inputHash === inputHash &&
      Array.isArray(receipt.evidence) &&
      receipt.evidence.length > 0;
    const uncertain =
      !!(receipt && !confirmed) ||
      !!(
        intent &&
        (["running", "needs-review"].includes(intent.status) ||
          (intent.status === "confirmed" && !confirmed))
      );
    records.push({
      dir,
      receiptFile,
      receipt,
      intent,
      confirmed,
      uncertain,
      savedAt: receipt?.finishedAt || receipt?.startedAt || "",
    });
  }
  return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
