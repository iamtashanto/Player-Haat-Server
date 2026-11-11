/** Writes the API contract to a file: `npx tsx scripts/export-openapi.ts ../web/src/lib/api/openapi.json` */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { buildOpenApiDocument } from "../src/lib/openapi.js";

createApp(); // importing the routes registers them
writeFileSync(process.argv[2] ?? "openapi.json", JSON.stringify(buildOpenApiDocument()));
