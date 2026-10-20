import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export class ProcessRunner {
  constructor({
    execPath = process.execPath,
    electron = false,
    worker = fileURLToPath(new URL("./worker.mjs", import.meta.url)),
  } = {}) {
    Object.assign(this, { execPath, electron, worker });
  }
  call(op, payload, { onEvent = () => {}, timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (this.electron) env.ELECTRON_RUN_AS_NODE = "1";
      else delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(this.execPath, [this.worker], {
        env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        shell: false,
        windowsHide: true,
      });
      let buffer = "",
        final,
        stderr = "",
        done = false;
      const timer = timeout
        ? setTimeout(() => {
            child.kill();
          }, timeout)
        : null;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === "result") final = e;
            else onEvent(e);
          } catch {
            onEvent({ type: "log", text: line.slice(0, 3000) });
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (s) => {
        stderr = (stderr + s).slice(-5000);
      });
      child.once("error", (e) => finish(e));
      child.once("close", (code, signal) => {
        if (code === 0 && final?.ok) finish(null, final.result);
        else
          finish(
            new Error(
              final?.error || `执行器退出：${signal || code}。${stderr}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ op, payload }));
    });
  }
}
