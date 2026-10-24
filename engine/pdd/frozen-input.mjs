import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";

// Bind the parsed execution payload to the independently produced preflight.
// The source-file hash alone does not protect a changed title or SKU payload.
export const executionHash = config => crypto.createHash("sha256")
  .update(JSON.stringify(config)).digest("hex");

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}

// Browser runtimes receive already parsed data. No spreadsheet library is loaded
// into Ego's browser SDK process; all frozen source bytes are checked here.
export async function assertFrozenFiles(config) {
  const root = await fs.realpath(config.materialRoot);
  const input = config.input;
  if (!input || !/^[a-f0-9]{64}$/.test(input.inputHash || "") ||
      path.basename(input.infoFile || "") !== input.infoFile || !input.infoFile)
    throw Error("缺少有效的冻结输入记录");
  const infoPath=input.infoPath||"商品信息/"+input.infoFile;
  if(path.basename(infoPath)!==input.infoFile)throw Error('商品表来源路径与文件名不符');
  const records = [{ file: infoPath, sha256: input.workbookSha256 }, ...(input.files || [])];
  for (const record of records) {
    const file = path.resolve(root, record.file);
    if (!inside(root, file) || !inside(root, await fs.realpath(file)))
      throw Error("冻结素材路径超出商品目录");
    if ((await fs.lstat(file)).isSymbolicLink() || await hashFile(file) !== record.sha256)
      throw Error("商品表或素材已改变，请重新读取并预检：" + record.file);
  }
}
