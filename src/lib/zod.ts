import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Adds `.openapi()` to every Zod schema. Import `z` from here (not "zod") in module
// schema files so the extension is guaranteed to have run before schemas are built.
extendZodWithOpenApi(z);

export { z };
