// The two builds land in one package, so each directory declares its own module kind:
// dist/esm is ESM, dist/cjs is CommonJS, whatever the root package.json says.
import { writeFileSync } from "node:fs";

writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
console.log("wrote dist/esm/package.json and dist/cjs/package.json");
