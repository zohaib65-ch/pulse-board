// `npm run dev`: starts the web app (next dev) and the Kafka worker together, with labelled logs.
// The dashboard is empty without the worker, so they are started as one. Ctrl+C stops both.
// Run them separately with `npm run dev:web` and `npm run dev:worker` if you prefer.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [
  { name: "web", color: 36, script: "dev:web" },
  { name: "worker", color: 35, script: "dev:worker" },
];

let stopping = false;
let running = processes.length;
let exitCode = 0;

const children = processes.map(({ name, color, script }) => {
  const child = spawn(npm, ["run", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const label = `\u001b[${color}m[${name}]\u001b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => console.log(`${label} ${line}`));
  }
  child.on("exit", (code, signal) => {
    running -= 1;
    if (!stopping) {
      // One side exiting on its own is worth saying out loud; the other keeps running.
      console.log(`${label} exited (${signal ?? `code ${code}`})${running > 0 ? "; the other process is still running" : ""}`);
      if (code) exitCode = code;
    }
    if (running === 0) process.exit(exitCode);
  });
  return child;
});

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  // Do not hang if something ignores SIGTERM.
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 8000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
