const apiPort = Number(process.env.API_PORT || "8080");
const smtpPort = Number(process.env.SMTP_PORT || "2525");
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) process.exit(1);
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) process.exit(1);

const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
if (!response.ok) process.exit(1);

const net = await import("node:net");
const socket = net.connect(smtpPort, "127.0.0.1");
const timer = setTimeout(() => process.exit(1), 4000);
socket.on("data", () => {
  clearTimeout(timer);
  socket.end();
  process.exit(0);
});
socket.on("error", () => process.exit(1));
