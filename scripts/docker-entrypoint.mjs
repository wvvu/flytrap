// If the data directory is root-owned, hand it to uid 1000 and run the server as node.
// A failed drop keeps the process up as the current user so mail intake does not stop.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";

const dataDir = process.env.MAIL_DATA_DIR || "/srv/mail/data";
const nodeArgs = process.argv.slice(2);
if (nodeArgs.length === 0) nodeArgs.push("dist/main.js");
const nodeUid = 1000;

function forward(child) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(err instanceof Error ? err.message : "spawn failed");
    process.exit(1);
  });
  forward(child);
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  mkdirSync(dataDir, { recursive: true });
  let ownedByNode = false;
  try {
    ownedByNode = statSync(dataDir).uid === nodeUid;
  } catch {
    ownedByNode = false;
  }
  if (!ownedByNode) {
    const chowned = spawnSync("chown", ["-R", `${nodeUid}:${nodeUid}`, dataDir], { stdio: "inherit" });
    if (chowned.status !== 0) process.exit(chowned.status ?? 1);
  }
  const probe = spawnSync("setpriv", ["--reuid=node", "--regid=node", "--init-groups", "true"], { stdio: "ignore" });
  if (probe.status === 0) {
    run("setpriv", ["--reuid=node", "--regid=node", "--init-groups", "--inh-caps=-all", process.execPath, ...nodeArgs]);
  } else {
    console.error("setpriv could not drop to node; starting as root");
    run(process.execPath, nodeArgs);
  }
} else {
  run(process.execPath, nodeArgs);
}
