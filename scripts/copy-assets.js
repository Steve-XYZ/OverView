// Copies the dashboard's static files next to the compiled app.js.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "dist/web");

await mkdir(target, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  await cp(resolve(root, "src/web", file), resolve(target, file));
}
console.log(`copied static assets to ${target}`);
