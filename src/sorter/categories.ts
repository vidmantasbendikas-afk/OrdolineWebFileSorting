/** The 11 photo categories and the mapping from the model's class names. */
import type { Category, CategoryId } from "./types.js";

export const DEFAULT_CLASSES = [
  "ceph_front", "ceph_side", "extr_profile_rest", "extr_profile_smile", "extr_rest", "extr_smile",
  "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
];

export const CATEGORIES: readonly Category[] = Object.freeze(([
  { id: "extraoral_frontal_rest", label: "Extraoral frontal (rest)" },
  { id: "extraoral_frontal_smile", label: "Extraoral frontal (smile)" },
  { id: "extraoral_profile_rest", label: "Extraoral profile (rest)" },
  { id: "extraoral_profile_smile", label: "Extraoral profile (smile)" },
  { id: "intraoral_frontal", label: "Intraoral frontal" },
  { id: "intraoral_left", label: "Intraoral left" },
  { id: "intraoral_right", label: "Intraoral right" },
  { id: "intraoral_upper", label: "Intraoral upper" },
  { id: "intraoral_lower", label: "Intraoral lower" },
  { id: "cephalometric_frontal", label: "Cephalometric (frontal)" },
  { id: "cephalometric_lateral", label: "Cephalometric (lateral)" },
] as Category[]).map((c) => Object.freeze(c)));
export const LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<CategoryId, string>;

export const CLASS_TO_CATEGORY: Record<string, CategoryId> = {
  extr_rest: "extraoral_frontal_rest",
  extr_smile: "extraoral_frontal_smile",
  extr_profile_rest: "extraoral_profile_rest",
  extr_profile_smile: "extraoral_profile_smile",
  intr_front: "intraoral_frontal",
  intr_left: "intraoral_left",
  intr_right: "intraoral_right",
  intr_upper: "intraoral_upper",
  intr_lower: "intraoral_lower",
  ceph_front: "cephalometric_frontal",
  ceph_side: "cephalometric_lateral",
};

// fallback for unknown class names; most specific patterns first
export const SUFFIX_RULES: ReadonlyArray<readonly [string, CategoryId]> = [
  ["profile_rest", "extraoral_profile_rest"], ["profile_smile", "extraoral_profile_smile"],
  ["ceph_front", "cephalometric_frontal"], ["ceph_side", "cephalometric_lateral"], ["lateral", "cephalometric_lateral"],
  ["rest", "extraoral_frontal_rest"], ["smile", "extraoral_frontal_smile"], ["front", "intraoral_frontal"],
  ["left", "intraoral_left"], ["right", "intraoral_right"], ["upper", "intraoral_upper"], ["lower", "intraoral_lower"],
];

export function classToCategory(cls: string): CategoryId {
  if (CLASS_TO_CATEGORY[cls]) return CLASS_TO_CATEGORY[cls];
  for (const [pattern, id] of SUFFIX_RULES) if (cls.includes(pattern)) return id;
  return CATEGORIES[0].id;
}
