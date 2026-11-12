// S-52 tokens the theme editor offers. Plain data, not in
// `ThemeEditorSection.tsx`, so the list stays testable without pulling in
// solid-js/lucide. Order is mariner priority, not `S52Colors`' declaration order.

import type { S52Colors } from "../s52Tables.generated";

export const S52_EDITOR_FIELDS: readonly { key: keyof S52Colors; label: string }[] = [
  { key: "CHMGD", label: "CHMGD — restricted-area lines" },
  { key: "CHMGF", label: "CHMGF — restricted-area fill" },
  { key: "TRFCD", label: "TRFCD — traffic / caution lines" },
  { key: "TRFCF", label: "TRFCF — separation-zone fill" },
  { key: "CHBLK", label: "CHBLK — chart black" },
  { key: "CHGRD", label: "CHGRD — chart grey" },
  { key: "CHGRF", label: "CHGRF — grey fill" },
  { key: "CHBRN", label: "CHBRN — chart brown" },
  { key: "LANDA", label: "LANDA — land" },
  { key: "LANDF", label: "LANDF — land structure edge" },
  { key: "CSTLN", label: "CSTLN — coastline" },
  { key: "DEPIT", label: "DEPIT — intertidal" },
  { key: "DEPVS", label: "DEPVS — very shallow" },
  { key: "DEPMS", label: "DEPMS — shallow" },
  { key: "DEPMD", label: "DEPMD — medium deep" },
  { key: "DEPDW", label: "DEPDW — deep" },
  { key: "DEPSC", label: "DEPSC — safety contour" },
  { key: "DEPCN", label: "DEPCN — other contours" },
  { key: "SNDG1", label: "SNDG1 — deep soundings" },
  { key: "SNDG2", label: "SNDG2 — shoal soundings" },
  { key: "LITRD", label: "LITRD — red light" },
  { key: "LITGN", label: "LITGN — green light" },
  { key: "LITYW", label: "LITYW — white / yellow light" },
  { key: "OUTLW", label: "OUTLW — symbol outline" },
  { key: "NODTA", label: "NODTA — no data" },
  { key: "UINFD", label: "UINFD — AIS / overlay ink" },
  { key: "UIBCK", label: "UIBCK — AIS / overlay halo" },
];
