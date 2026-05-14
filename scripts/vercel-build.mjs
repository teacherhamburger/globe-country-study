/**
 * Vercel 需要建置後存在 output 目錄（預設 public/）。
 * 將靜態資產複製到 public/，路徑仍為 /、/js/、/data/。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pub = join(root, "public");

if (existsSync(pub)) rmSync(pub, { recursive: true });
mkdirSync(pub, { recursive: true });

cpSync(join(root, "index.html"), join(pub, "index.html"));
cpSync(join(root, "js"), join(pub, "js"), { recursive: true });
cpSync(join(root, "data"), join(pub, "data"), { recursive: true });

console.log("vercel-build: copied index.html, js/, data/ -> public/");
