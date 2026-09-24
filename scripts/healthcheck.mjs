import net from "node:net";

const roles = new Set(
  (process.env.ROLES || "smtp,worker,api")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean),
);

const apiPort = Number(process.env.API_PORT || "8080");
const smtpPort = Number(process.env.SMTP_PORT || "2525");

try {
  if (roles.has("api")) {
    if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) process.exit(1);
    const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
    if (!response.ok) process.exit(1);
  }

  if (roles.has("smtp")) {
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) process.exit(1);
    const banner = await readSmtpBanner(smtpPort);
    if (!banner.startsWith("220")) process.exit(1);
  }
} catch {
  process.exit(1);
}

process.exit(0);

function readSmtpBanner(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("smtp banner timeout"));
    }, 4000);
    const finish = (err, line) => {
      clearTimeout(timer);
      socket.end();
      if (err) reject(err);
      else resolve(line);
    };
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const end = buf.search(/\r?\n/);
      if (end >= 0) finish(null, buf.slice(0, end));
    });
    socket.on("error", (err) => finish(err));
  });
}
