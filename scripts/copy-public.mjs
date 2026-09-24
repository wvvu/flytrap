import { cpSync } from "node:fs";

cpSync("src/api/public", "dist/api/public", { recursive: true });
