import type { UpazilaSeed } from "../locations.js";

/**
 * DEMO SUBSET — Patuakhali district only, so local development and the demo
 * requests work out of the box. Typed by hand: verify against the official BBS
 * list (or replace with `locations-full.json`, see ./README.md) before launch.
 */
export const demoUpazilas: UpazilaSeed[] = [
  { district: "Patuakhali", nameEn: "Patuakhali Sadar", nameBn: "পটুয়াখালী সদর" },
  { district: "Patuakhali", nameEn: "Bauphal", nameBn: "বাউফল" },
  { district: "Patuakhali", nameEn: "Dashmina", nameBn: "দশমিনা" },
  { district: "Patuakhali", nameEn: "Dumki", nameBn: "দুমকি" },
  { district: "Patuakhali", nameEn: "Galachipa", nameBn: "গলাচিপা" },
  {
    district: "Patuakhali",
    nameEn: "Kalapara",
    nameBn: "কলাপাড়া",
    unions: [
      { nameEn: "Latachapli", nameBn: "লতাচাপলী" }, // Kuakata sea beach area
      { nameEn: "Mohipur", nameBn: "মহিপুর" },
      { nameEn: "Dhankhali", nameBn: "ধানখালী" },
      { nameEn: "Nilganj", nameBn: "নীলগঞ্জ" },
      { nameEn: "Tiakhali", nameBn: "টিয়াখালী" },
      { nameEn: "Lalua", nameBn: "লালুয়া" },
    ],
  },
  { district: "Patuakhali", nameEn: "Mirzaganj", nameBn: "মির্জাগঞ্জ" },
  { district: "Patuakhali", nameEn: "Rangabali", nameBn: "রাঙ্গাবালী" },
];
