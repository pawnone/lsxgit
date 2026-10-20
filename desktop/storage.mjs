import fs from "node:fs/promises";
import path from "node:path";
export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error("本机记录无法读取，未重置：" + file + "。" + e.message);
  }
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
export class Store {
  constructor(root) {
    this.root = root;
    this.chain = Promise.resolve();
  }
  read(name, fallback = null) {
    return readJson(path.join(this.root, name), fallback);
  }
  write(name, data) {
    const copy = structuredClone(data);
    const task = this.chain.then(() =>
      writeJson(path.join(this.root, name), copy),
    );
    this.chain = task.catch(() => {});
    return task;
  }
  async recoverLock() {
    const file = path.join(this.root, "app-run.lock"),
      lock = await readJson(file);
    if (!lock) return;
    if (!Number.isInteger(lock.pid) || lock.pid <= 0)
      throw Error("执行锁损坏，请核实本机执行记录；未自动清理");
    try {
      process.kill(lock.pid, 0);
      throw Error("另一个执行进程仍在运行，请勿重复启动");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    await fs.rename(file, file + ".recovered-" + Date.now());
  }
  async lock() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      this.handle = await fs.open(path.join(this.root, "app-run.lock"), "wx");
      await this.handle.writeFile(
        JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
      );
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          "存在未清理的执行锁；请先核实是否仍有任务及草稿结果，不能重复启动",
        );
      throw e;
    }
  }
  async unlock() {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
      await fs.unlink(path.join(this.root, "app-run.lock"));
    }
  }
}
