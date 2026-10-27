export interface SportSeed {
  code: string;
  nameEn: string;
  nameBn: string;
  positions: Array<{ code: string; nameEn: string; nameBn: string }>;
}

export const sports: SportSeed[] = [
  {
    code: "FOOTBALL",
    nameEn: "Football",
    nameBn: "ফুটবল",
    positions: [
      { code: "GK", nameEn: "Goalkeeper", nameBn: "গোলরক্ষক" },
      { code: "CB", nameEn: "Centre Back", nameBn: "সেন্টার ব্যাক" },
      { code: "FB", nameEn: "Full Back", nameBn: "ফুলব্যাক" },
      { code: "DM", nameEn: "Defensive Midfielder", nameBn: "ডিফেন্সিভ মিডফিল্ডার" },
      { code: "CM", nameEn: "Central Midfielder", nameBn: "সেন্ট্রাল মিডফিল্ডার" },
      { code: "AM", nameEn: "Attacking Midfielder", nameBn: "অ্যাটাকিং মিডফিল্ডার" },
      { code: "WING", nameEn: "Winger", nameBn: "উইঙ্গার" },
      { code: "ST", nameEn: "Striker", nameBn: "স্ট্রাইকার" },
    ],
  },
  {
    code: "CRICKET",
    nameEn: "Cricket",
    nameBn: "ক্রিকেট",
    positions: [
      { code: "BATTER", nameEn: "Batter", nameBn: "ব্যাটার" },
      { code: "BOWLER", nameEn: "Bowler", nameBn: "বোলার" },
      { code: "ALLROUNDER", nameEn: "All-rounder", nameBn: "অলরাউন্ডার" },
      { code: "KEEPER", nameEn: "Wicket-keeper", nameBn: "উইকেটকিপার" },
    ],
  },
];
