import { access, readFile } from "node:fs/promises";

const clientRoot = new URL("../dist/client/", import.meta.url);
const html = await readFile(new URL("index.html", clientRoot), "utf8");
const bootstrapTag = '<script src="/theme-bootstrap.js"></script>';
const bootstrapPosition = html.indexOf(bootstrapTag);
const clientPosition = html.indexOf('<script type="module"');

if (bootstrapPosition < 0 || clientPosition < 0 || bootstrapPosition > clientPosition) {
  throw new Error("Production HTML must retain the classic theme bootstrap before the client module.");
}

await access(new URL("theme-bootstrap.js", clientRoot));
console.log("Theme bootstrap verification: independent pre-paint script retained.");
