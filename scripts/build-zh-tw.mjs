/**
 * 將 data/countries.json 內 nameZh（簡體）轉為臺灣繁體（OpenCC twp），並將 TW 固定為「台灣」。
 * 若已為繁體再執行通常仍安全；若從頭匯入資料，請先還原簡體 nameZh 再跑此腳本。
 */
import * as OpenCC from "opencc-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, "..", "data", "countries.json");

const toTw = OpenCC.Converter({ from: "cn", to: "twp" });

const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
for (const c of raw) {
  if (c.iso2 === "TW") {
    c.nameZh = "台灣";
    continue;
  }
  c.nameZh = toTw(c.nameZh || "");
}

fs.writeFileSync(dataPath, JSON.stringify(raw));
console.log("Updated", raw.length, "countries → zh-TW (twp), TW → 台灣");
