// `npm run dev`: starts the web app and the Kafka worker together for local development.
//
// They stay two separate processes (the worker is never part of the web server); this script
// only launches both and shows their output side by side, prefixed with [web] and [worker].
//   - Ctrl+C stops both (the worker shuts down gracefully).
//   - If the web app exits, everything stops.
//   - If the worker exits (for example after a configuration error), the web app keeps running
//     and the message tells you how to start the worker again.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const isWindows = process.platform === "win32";
const useColor = process.stdout.isTTY;
const npm = isWindows ? "npm.cmd" : "npm";

const services = [
  { name: "web", command: npm, args: ["run", "dev:web"], color: 36, stopsEverything: true },
  { name: "worker", command: npm, args: ["run", "dev:worker"], color: 35, stopsEverything: false },
];

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

const tag = (service) => {
  const text = `[${service.name}]`.padEnd(9);
  return useColor ? `\x1b[${service.color}m${text}\x1b[0m` : text;
};

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (children.size === 0) process.exit(exitCode);
  for (const child of children.values()) child.kill("SIGINT");
  // Safety net: never hang if something ignores the signal.
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 10_000).unref();
}

function start(service) {
  const child = spawn(service.command, service.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    env: { ...process.env, ...(useColor ? { FORCE_COLOR: "1" } : {}) },
  });
  children.set(service.name, child);

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => console.log(`${tag(service)} ${line}`));
  }

  child.on("error", (error) => {
    console.log(`${tag(service)} could not start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    children.delete(service.name);
    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    console.log(`${tag(service)} exited (${signal ?? `code ${code}`})`);
    if (service.stopsEverything) {
      shutdown(code ?? 1);
    } else {
      console.log(`${tag(service)} The web app keeps running. Fix the problem, then run "npm run dev:worker" in another terminal.`);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
services.forEach(start);
