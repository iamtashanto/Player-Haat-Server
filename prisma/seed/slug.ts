/** "Cox's Bazar" -> "coxs-bazar". Names are English-only here; Bangla is never slugged. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
