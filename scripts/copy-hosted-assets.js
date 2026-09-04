// Copies only the browser modules used by the dashboard into Vercel's static directory.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["dist/web/index.html", "public/web/index.html"],
  ["dist/web/styles.css", "public/web/styles.css"],
  ["dist/web/app.js", "public/web/app.js"],
  ["dist/report/text.js", "public/report/text.js"],
  ["dist/domain/time.js", "public/domain/time.js"],
  ["src/hosted/login.html", "public/login.html"],
];

for (const [source, target] of files) {
  if (source === undefined || target === undefined) continue;
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, source), destination);
}

console.log("copied hosted dashboard assets to public");
