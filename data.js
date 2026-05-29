// =============================================================================
// PaedSafe — data.js
// Clinical data layer — authoritative source of truth for all drug, airway,
// fluid, and regional anaesthesia data.
//
// RULES (from 03_technical_architecture.md):
//   - No calculation logic in this file
//   - No DOM access
//   - All data deeply frozen after assignment
//   - Schema validated at load time — hard fail on any violation
//   - When any entry is updated, bump version in that entry AND in PAEDSAFE_CONFIG
//
// Clinical content sourced from: 02_clinical_scope.md v1.3
// Author: Dr. John Afam-Osemene
// =============================================================================

"use strict";

// =============================================================================
// SECTION 1 — CONFIG (single source of truth for all cross-file constants)
// =============================================================================

const PAEDSAFE_CONFIG = {
version:   "2.1.0",
cacheName: "paed-safe-v2.1.0",
  sessionTimeout: 30,       // minutes before inactive session is discarded
  maxWeightKg:    150,
  maxAgeMonths:   216,      // 18 years
  weightEstimation: {
    weech: {
      bands: [
        { label: "Infant (0–11 months)",  minMonths: 0,  maxMonths: 11,  formula: "(months + 9) ÷ 2" },
        { label: "Child (1–6 years)",     minMonths: 12, maxMonths: 83,  formula: "(years × 2) + 8"   },
        { label: "Child (7–12 years)",    minMonths: 84, maxMonths: 144, formula: "((years × 7) − 5) ÷ 2" }
      ],
      reference: "Weech AA. Pediatrics 1954",
      warning:   "Age-based estimate only — use actual weight whenever available."
    }
  }
};


// =============================================================================
// SECTION 2 — UTILITIES
// =============================================================================

/**
 * Recursively freeze an object and all nested objects.
 * Prevents runtime mutation of any clinical data entry.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  Object.getOwnPropertyNames(obj).forEach(name => {
    const val = obj[name];
    if (val && typeof val === "object") deepFreeze(val);
  });
  return Object.freeze(obj);
}

/**
 * Validate every drug entry against the required schema.
 * Hard-fails the app if any field is missing or wrong type.
 * Required fields per 03_technical_architecture.md §5 data.js:
 *   id, name, category, routes, doseMin, doseMax, unit,
 *   maxDose, warnings, reference, version, neonateFlag
 */
function validateDrugSchema(drug) {
  const required = [
    ["id",          "string"],
    ["name",        "string"],
    ["category",    "string"],
    ["routes",      "array"],
    ["doseMin",     "number"],
    ["doseMax",     "number"],
    ["unit",        "string"],
    // maxDose: number or null
    ["warnings",    "array"],
    ["reference",   "string"],
    ["version",     "string"],
    ["neonateFlag", "boolean"]
  ];

  for (const [field, type] of required) {
    if (!(field in drug)) {
      throw new Error(`Schema violation: drug "${drug.id || "UNKNOWN"}" missing field "${field}"`);
    }
    if (type === "array") {
      if (!Array.isArray(drug[field])) {
        throw new Error(`Schema violation: drug "${drug.id}" field "${field}" must be an array`);
      }
    } else {
      if (typeof drug[field] !== type) {
        throw new Error(`Schema violation: drug "${drug.id}" field "${field}" must be ${type}, got ${typeof drug[field]}`);
      }
    }
  }

  // maxDose: must be number or null
  if (drug.maxDose !== null && typeof drug.maxDose !== "number") {
    throw new Error(`Schema violation: drug "${drug.id}" field "maxDose" must be number or null`);
  }

  // warnings must be array of strings
  if (!drug.warnings.every(w => typeof w === "string")) {
    throw new Error(`Schema violation: drug "${drug.id}" warnings must be array of strings`);
  }

  // routes must be array of strings
  if (!drug.routes.every(r => typeof r === "string")) {
    throw new Error(`Schema violation: drug "${drug.id}" routes must be array of strings`);
  }

  return true;
}

/**
 * Run schema validation against all drugs in an array.
 * Throws on first violation — app will catch and hard-fail.
 */
function validateAllDrugs(drugs) {
  for (const drug of drugs) {
    validateDrugSchema(drug);
  }
}


// =============================================================================
// SECTION 3 — DRUG DATABASE
// All doses sourced from 02_clinical_scope.md v1.3
// Reference key:
//   REF1 = BNF for Children
//   REF2 = Steward & Lerman, Manual of Pediatric Anesthesia 6th ed
//   REF3 = APAGBI PONV Guidelines 2016
//   REF8 = APLS 6th ed
//   REF9 = APAGBI Pain Guidelines 2012
// =============================================================================

const _drugs = [

  // ---------------------------------------------------------------------------
  // CATEGORY: induction
  // ---------------------------------------------------------------------------
  {
    id:          "propofol-induction",
    name:        "Propofol",
    category:    "induction",
    routes:      ["IV"],
    doseMin:     2,
    doseMax:     3,
    unit:        "mg/kg",
    maxDose:     null,
    adultCapMg:  200,   // clinical ceiling — not in schema but used by calc.js
    warnings: [
      "Reduce to 1–2 mg/kg in haemodynamic compromise or ASA III–IV.",
      "Use with caution in neonates — increased Vd but poor cardiovascular reserve."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "ketamine-induction-iv",
    name:        "Ketamine (IV induction)",
    category:    "induction",
    routes:      ["IV"],
    doseMin:     1,
    doseMax:     2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "IV route: 1–2 mg/kg. For IM use, see Ketamine IM."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "ketamine-induction-im",
    name:        "Ketamine (IM induction)",
    category:    "induction",
    routes:      ["IM"],
    doseMin:     4,
    doseMax:     5,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Onset variability increases above 5 mg/kg without added benefit.",
      "IM route — use for premedication or when IV access unavailable."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "thiopentone-induction",
    name:        "Thiopentone",
    category:    "induction",
    routes:      ["IV"],
    doseMin:     4,
    doseMax:     6,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Reduce dose in neonates — higher sensitivity and poor cardiovascular reserve."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: true
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: nmba (neuromuscular blocking agents / muscle relaxants)
  // ---------------------------------------------------------------------------
  {
    id:          "suxamethonium",
    name:        "Suxamethonium",
    category:    "nmba",
    routes:      ["IV"],
    doseMin:     1,
    doseMax:     2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Use lower end (1 mg/kg) in neonates.",
      "Consider atropine 20 mcg/kg co-administration in infants to prevent bradycardia.",
      "Onset 30–60 seconds."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "atracurium",
    name:        "Atracurium",
    category:    "nmba",
    routes:      ["IV"],
    doseMin:     0.5,
    doseMax:     0.5,
    unit:        "mg/kg",
    maxDose:     null,
    maintenanceMin: 0.1,
    maintenanceMax: 0.2,
    maintenanceUnit: "mg/kg",
    warnings: [
      "Intubating dose: 0.5 mg/kg. Maintenance: 0.1–0.2 mg/kg.",
      "Onset 2–3 minutes."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "rocuronium",
    name:        "Rocuronium",
    category:    "nmba",
    routes:      ["IV"],
    doseMin:     0.6,
    doseMax:     1.2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Intubation dose: 0.6 mg/kg. RSI dose: 1.2 mg/kg.",
      "Onset 60–90 seconds.",
      "Maintenance: 0.1–0.15 mg/kg.",
      "Reversible with Sugammadex."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "vecuronium",
    name:        "Vecuronium",
    category:    "nmba",
    routes:      ["IV"],
    doseMin:     0.1,
    doseMax:     0.1,
    unit:        "mg/kg",
    maxDose:     null,
    maintenanceMin: 0.02,
    maintenanceMax: 0.05,
    maintenanceUnit: "mg/kg",
    warnings: [
      "Intubating dose: 0.1 mg/kg. Maintenance: 0.02–0.05 mg/kg.",
      "Onset 2–3 minutes.",
      "Reversible with Sugammadex."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: opioid
  // ---------------------------------------------------------------------------
  {
    id:          "morphine",
    name:        "Morphine",
    category:    "opioid",
    routes:      ["IV"],
    doseMin:     0.1,
    doseMax:     0.2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Give IV slowly — titrate to effect.",
      "Use with EXTREME CAUTION in neonates: prolonged half-life and significant respiratory depression risk.",
      "Not absolutely contraindicated in ICU settings with monitoring."
    ],
    reference:   "BNF for Children (current ed); APAGBI Pain Guidelines 2012",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "fentanyl",
    name:        "Fentanyl",
    category:    "opioid",
    routes:      ["IV"],
    doseMin:     1,
    doseMax:     3,
    unit:        "mcg/kg",
    maxDose:     null,
    warnings: [
      "Analgesic dose: 1–3 mcg/kg IV.",
      "Intubation dose: 2–4 mcg/kg IV.",
      "Doses <1 mcg/kg — verify to 2 decimal places."
    ],
    reference:   "BNF for Children (current ed); APAGBI Pain Guidelines 2012",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "tramadol",
    name:        "Tramadol",
    category:    "opioid",
    routes:      ["IV", "IM"],
    doseMin:     1,
    doseMax:     2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "For children >1 year only — do not use in infants.",
      "Not recommended in children under 12 years by some regulatory bodies — check local protocol."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "pethidine",
    name:        "Pethidine",
    category:    "opioid",
    routes:      ["IV", "IM"],
    doseMin:     1,
    doseMax:     2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "AVOID IN NEONATES.",
      "IV: give slowly — titrate to effect.",
      "IM: anterolateral thigh preferred in children.",
      "Accumulation of norpethidine metabolite may cause seizures with repeated dosing — avoid repeated doses."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.1.0",
    neonateFlag: true
  },
  {
    id:          "pentazocine",
    name:        "Pentazocine",
    category:    "opioid",
    routes:      ["IV"],
    doseMin:     0.5,
    doseMax:     1,
    unit:        "mg/kg",
    maxDose:     30,
    warnings: [
      "Maximum single dose: 30 mg regardless of weight.",
      "Give IV SLOWLY.",
      "Opioid agonist-antagonist — AVOID in patients on full opioid agonists (may precipitate withdrawal).",
      "NOT RECOMMENDED in children <1 year."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: true
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: reversal
  // ---------------------------------------------------------------------------
  {
    id:          "neostigmine",
    name:        "Neostigmine",
    category:    "reversal",
    routes:      ["IV"],
    doseMin:     0.05,
    doseMax:     0.05,
    unit:        "mg/kg",
    maxDose:     2.5,
    warnings: [
      "ALWAYS give with an anticholinergic (atropine or glycopyrrolate).",
      "Maximum dose: 2.5 mg."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "atropine-reversal",
    name:        "Atropine (with neostigmine)",
    category:    "reversal",
    routes:      ["IV"],
    doseMin:     0.02,
    doseMax:     0.02,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Minimum dose: 0.1 mg (regardless of weight) to avoid paradoxical bradycardia.",
      "Give before or with neostigmine."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "glycopyrrolate-reversal",
    name:        "Glycopyrrolate (with neostigmine)",
    category:    "reversal",
    routes:      ["IV"],
    doseMin:     0.01,
    doseMax:     0.01,
    unit:        "mg/kg",
    maxDose:     0.2,
    warnings: [
      "Preferred anticholinergic alternative to atropine — less tachycardia, no CNS penetration.",
      "Maximum dose: 0.2 mg.",
      "Give with or just before neostigmine."
    ],
    reference:   "BNF for Children (current ed); Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "sugammadex",
    name:        "Sugammadex",
    category:    "reversal",
    routes:      ["IV"],
    doseMin:     2,
    doseMax:     16,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Moderate block: 2 mg/kg.",
      "Deep block: 4 mg/kg.",
      "Immediate reversal (RSI rescue): 16 mg/kg.",
      "Rocuronium and vecuronium ONLY — not effective for other NMBAs."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: antiemetic
  // ---------------------------------------------------------------------------
  {
    id:          "ondansetron",
    name:        "Ondansetron",
    category:    "antiemetic",
    routes:      ["IV"],
    doseMin:     0.1,
    doseMax:     0.1,
    unit:        "mg/kg",
    maxDose:     4,
    warnings: [
      "For children >1 month. Maximum dose: 4 mg.",
      "Use CAUTIOUSLY in children <6 months — limited evidence, off-label in many protocols."
    ],
    reference:   "APAGBI PONV Guidelines 2016",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "dexamethasone-ponv",
    name:        "Dexamethasone (PONV prophylaxis)",
    category:    "antiemetic",
    routes:      ["IV"],
    doseMin:     0.15,
    doseMax:     0.15,
    unit:        "mg/kg",
    maxDose:     8,
    warnings: [
      "Maximum dose: 8 mg.",
      "PONV prophylaxis use."
    ],
    reference:   "APAGBI PONV Guidelines 2016",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "metoclopramide",
    name:        "Metoclopramide",
    category:    "antiemetic",
    routes:      ["IV", "IM", "PO"],
    doseMin:     0.1,
    doseMax:     0.15,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "AVOID IN CHILDREN <1 YEAR — risk of extrapyramidal side effects.",
      "Risk of acute dystonic reactions — particularly in young children."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: true
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: analgesic
  // ---------------------------------------------------------------------------
  {
    id:          "paracetamol",
    name:        "Paracetamol",
    category:    "analgesic",
    routes:      ["IV", "PR", "PO"],
    doseMin:     15,
    doseMax:     15,
    unit:        "mg/kg",
    maxDose:     null,
    adultCapMg:  1000,   // single dose adult cap
    dailyMaxPerKg: 60,   // mg/kg/day
    dailyAdultCapMg: 4000,
    warnings: [
      "Maximum 60 mg/kg/day (adult maximum 4 g/day).",
      "Do not exceed adult single dose of 1000 mg."
    ],
    reference:   "BNF for Children (current ed); APAGBI Pain Guidelines 2012",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "ibuprofen",
    name:        "Ibuprofen",
    category:    "analgesic",
    routes:      ["PO"],
    doseMin:     5,
    doseMax:     10,
    unit:        "mg/kg",
    maxDose:     null,
    dailyMaxPerKg: 30,
    warnings: [
      "For children >3 months only.",
      "Maximum 30 mg/kg/day.",
      "Avoid in renal impairment, hypovolaemia, or bleeding risk."
    ],
    reference:   "BNF for Children (current ed); APAGBI Pain Guidelines 2012",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "diclofenac",
    name:        "Diclofenac",
    category:    "analgesic",
    routes:      ["PR", "IM"],
    doseMin:     1,
    doseMax:     1,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "For children >1 year only.",
      "Avoid in renal impairment, hypovolaemia, or bleeding risk."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: true
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: sedation (premedication)
  // ---------------------------------------------------------------------------
  {
    id:          "midazolam-po",
    name:        "Midazolam (oral premedication)",
    category:    "sedation",
    routes:      ["PO"],
    doseMin:     0.3,
    doseMax:     0.5,
    unit:        "mg/kg",
    maxDose:     15,
    warnings: [
      "Maximum dose: 15 mg.",
      "Give 30–45 minutes before procedure.",
      "Monitor for respiratory depression."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "midazolam-iv",
    name:        "Midazolam (IV)",
    category:    "sedation",
    routes:      ["IV"],
    doseMin:     0.05,
    doseMax:     0.1,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Titrate IV — give slowly.",
      "Monitor for respiratory depression.",
      "Preferred benzodiazepine in theatre."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: true
  },
  {
    id:          "clonidine-premedication",
    name:        "Clonidine (oral premedication)",
    category:    "sedation",
    routes:      ["PO"],
    doseMin:     4,
    doseMax:     4,
    unit:        "mcg/kg",
    maxDose:     null,
    warnings: [
      "Adjunct premedication only.",
      "May cause hypotension and bradycardia — monitor haemodynamics."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: false
  },

  // ---------------------------------------------------------------------------
  // CATEGORY: anticonvulsant
  // ---------------------------------------------------------------------------
  {
    id:          "diazepam-seizure",
    name:        "Diazepam (seizure)",
    category:    "anticonvulsant",
    routes:      ["IV"],
    doseMin:     0.1,
    doseMax:     0.3,
    unit:        "mg/kg",
    maxDose:     10,
    warnings: [
      "Give IV SLOWLY.",
      "Maximum dose: 10 mg.",
      "Monitor for respiratory depression."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "midazolam-seizure",
    name:        "Midazolam (seizure)",
    category:    "anticonvulsant",
    routes:      ["IV"],
    doseMin:     0.1,
    doseMax:     0.2,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Preferred agent in theatre for perioperative seizure.",
      "Monitor for respiratory depression."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "phenobarbitone",
    name:        "Phenobarbitone (loading)",
    category:    "anticonvulsant",
    routes:      ["IV"],
    doseMin:     15,
    doseMax:     20,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Loading dose — give as slow IV infusion.",
      "Monitor for respiratory depression and hypotension.",
      "Have airway support immediately available."
    ],
    reference:   "BNF for Children (current ed); APLS 6th ed",
    version:     "1.0.0",
    neonateFlag: false
  },
  {
    id:          "levetiracetam",
    name:        "Levetiracetam (loading)",
    category:    "anticonvulsant",
    routes:      ["IV"],
    doseMin:     20,
    doseMax:     30,
    unit:        "mg/kg",
    maxDose:     null,
    warnings: [
      "Infuse over 15 minutes.",
      "Loading dose only — for maintenance, consult neurology."
    ],
    reference:   "BNF for Children (current ed)",
    version:     "1.0.0",
    neonateFlag: false
  }

];

// Run schema validation — store any error for index.html to handle.
// Do NOT throw here or access DOM — data.js has no DOM access.
// index.html dependency guard checks window.PaedSafe.schemaError after load.
let _schemaError = null;
try {
  validateAllDrugs(_drugs);
} catch (e) {
  _schemaError = e.message;
}


// =============================================================================
// SECTION 4 — EMERGENCY DRUGS
// Separate from the main drug list — displayed in Emergency module with
// distinct visual treatment per 04_ui_ux_principles.md §11
// =============================================================================

const _emergencyDrugs = [
  {
    id:           "adrenaline-arrest",
    name:         "Adrenaline — Cardiac Arrest",
    emergencyType:"cardiac-arrest",
    route:        "IV/IO",
    doseMcgPerKg: 10,
    concentration:"1:10,000 (10 mcg/ml)",
    volumePerKg:  0.1,   // ml/kg
    unit:         "mcg/kg",
    warnings: [
      "⚠️ CONCENTRATION: 1:10,000 (10 mcg/ml) — IV/IO ONLY.",
      "Volume: 0.1 ml/kg of 1:10,000 solution.",
      "DO NOT use 1:1,000 for IV/IO arrest — fatal overdose risk."
    ],
    reference:    "APLS 6th ed; WHO Pocket Book 2013",
    version:      "1.0.0"
  },
  {
    id:           "adrenaline-anaphylaxis",
    name:         "Adrenaline — Anaphylaxis",
    emergencyType:"anaphylaxis",
    route:        "IM",
    doseMcgPerKg: 10,
    concentration:"1:1,000 (1 mg/ml)",
    volumePerKg:  0.01,  // ml/kg
    unit:         "mcg/kg",
    warnings: [
      "⚠️ CONCENTRATION: 1:1,000 (1 mg/ml) — IM ONLY.",
      "Volume: 0.01 ml/kg of 1:1,000 solution.",
      "DO NOT use 1:1,000 IV — use 1:10,000 for IV/IO cardiac arrest only."
    ],
    reference:    "APLS 6th ed; WHO Pocket Book 2013",
    version:      "1.0.0"
  },
  {
    id:           "atropine-bradycardia",
    name:         "Atropine (bradycardia)",
    emergencyType:"bradycardia",
    route:        "IV",
    doseMin:      0.02,
    doseMax:      0.02,
    unit:         "mg/kg",
    minDoseMg:    0.1,
    maxDoseMg:    0.5,
    warnings: [
      "Minimum dose 0.1 mg (to avoid paradoxical bradycardia).",
      "Maximum dose 0.5 mg."
    ],
    reference:    "APLS 6th ed",
    version:      "1.0.0"
  },
  {
    id:           "adenosine-svt-1",
    name:         "Adenosine — SVT (1st dose)",
    emergencyType:"svt",
    route:        "Rapid IV push",
    doseMin:      0.1,
    doseMax:      0.1,
    unit:         "mg/kg",
    maxDoseMg:    6,
    warnings: [
      "Give as RAPID IV push followed immediately by saline flush.",
      "Maximum 1st dose: 6 mg.",
      "Use central or large peripheral vein, as close to heart as possible."
    ],
    reference:    "APLS 6th ed",
    version:      "1.0.0"
  },
  {
    id:           "adenosine-svt-2",
    name:         "Adenosine — SVT (2nd dose)",
    emergencyType:"svt",
    route:        "Rapid IV push",
    doseMin:      0.2,
    doseMax:      0.2,
    unit:         "mg/kg",
    maxDoseMg:    12,
    warnings: [
      "Give only if 1st dose unsuccessful.",
      "Maximum 2nd dose: 12 mg.",
      "Rapid IV push — same technique as 1st dose."
    ],
    reference:    "APLS 6th ed",
    version:      "1.0.0"
  },
  {
    id:           "calcium-gluconate",
    name:         "Calcium Gluconate (10%)",
    emergencyType:"electrolyte",
    route:        "Slow IV",
    volumePerKgMin: 0.1,
    volumePerKgMax: 0.2,
    unit:         "ml/kg of 10% solution",
    doseMin:      0.1,
    doseMax:      0.2,
    warnings: [
      "Give SLOWLY intravenously.",
      "Monitor ECG during administration.",
      "Use 10% solution only — verify concentration before drawing up."
    ],
    reference:    "APLS 6th ed; BNF for Children",
    version:      "1.0.0"
  },
  {
    id:           "sodium-bicarbonate",
    name:         "Sodium Bicarbonate",
    emergencyType:"electrolyte",
    route:        "IV",
    doseMin:      1,
    doseMax:      2,
    unit:         "mmol/kg",
    warnings: [
      "Dilute 1:1 with water for injection in NEONATES before administration.",
      "Give slowly — avoid rapid infusion.",
      "Use only with evidence of severe metabolic acidosis."
    ],
    reference:    "APLS 6th ed; BNF for Children",
    version:      "1.0.0",
    neonateFlag:  true
  },
  {
    id:           "glucose-hypoglycaemia",
    name:         "Glucose (hypoglycaemia)",
    emergencyType:"metabolic",
    route:        "IV",
    volumePerKg:  2,
    unit:         "ml/kg of 10% dextrose",
    doseMin:      2,
    doseMax:      2,
    warnings: [
      "Use 10% dextrose (D10) — NOT D50 directly.",
      "LOW-RESOURCE TIP: To make D10 from D50 — draw 1 ml D50 + add 4 ml sterile water = 5 ml D10. Repeat as needed.",
      "Recheck blood glucose after 15 minutes."
    ],
    reference:    "WHO Pocket Book of Hospital Care for Children 2013; APLS 6th ed",
    version:      "1.0.0"
  }
];


// =============================================================================
// SECTION 5 — AIRWAY DATA
// Source: 02_clinical_scope.md Module 2
// =============================================================================

const _airwayData = {

  // ETT formulas are computed by calc.js — these are reference boundaries
  ettFormulas: {
    uncuffedId:   { formula: "(Age ÷ 4) + 4",        ageMinYears: 1 },
    cuffedId:     { formula: "(Age ÷ 4) + 3.5",      ageMinYears: 1 },
    lengthOral:   { formula: "(Age ÷ 2) + 12 cm",    ageMinYears: 1 },
    lengthNasal:  { formula: "(Age ÷ 2) + 15 cm",    ageMinYears: 1 },
    infantOral:   { formula: "Weight (kg) + 6 cm",   ageMaxYears: 1 },
    neonateOral:  { note:    "Neonate (~3 kg): 9 cm at the lip as starting point" }
  },
  ettWarnings: [
    "These are estimates only — always confirm placement with leak test (uncuffed) or cuff pressure monitoring and capnography.",
    "Age-based length formula unreliable in neonates and infants — prioritise weight-based estimation and clinical confirmation.",
    "Always have one size above and one size below ready.",
    "Modern practice increasingly favours cuffed tubes at all ages with appropriately adjusted sizing — consider local protocol."
  ],

  // LMA sizing by weight (02_clinical_scope.md §2.2)
  lma: [
    { maxWeightKg: 5,  size: 1,   maxCuffMl: 4  },
    { maxWeightKg: 10, size: 1.5, maxCuffMl: 7  },
    { maxWeightKg: 20, size: 2,   maxCuffMl: 10 },
    { maxWeightKg: 30, size: 2.5, maxCuffMl: 14 },
    { maxWeightKg: 50, size: 3,   maxCuffMl: 20 }
  ],

  // Laryngoscope blade (02_clinical_scope.md §2.3)
  laryngoscope: [
    { label: "Neonate / Infant",  type: "Straight (Miller)", size: "0–1" },
    { label: "1–2 years",         type: "Straight or Curved", size: "1"  },
    { label: "2–8 years",         type: "Curved (Macintosh)", size: "2"  },
    { label: ">8 years",          type: "Curved (Macintosh)", size: "2–3"}
  ],

  // Suction catheter: ETT size × 2 = French size (calc.js computes this)
  suctionFormula: "ETT size × 2 = Suction catheter French size",

  // Face mask by age/weight (02_clinical_scope.md §2.5)
  faceMask: [
    { label: "Premature neonate",     maxWeightKg: 1.5,  size: "0"   },
    { label: "Term neonate",          maxWeightKg: 3.5,  size: "0–1" },
    { label: "Infant (1–6 months)",   maxWeightKg: 7,    size: "1"   },
    { label: "Infant (6–12 months)",  maxWeightKg: 10,   size: "1–2" },
    { label: "Toddler (1–2 years)",   maxWeightKg: 13,   size: "2"   },
    { label: "Child (2–5 years)",     maxWeightKg: 18,   size: "2–3" },
    { label: "Child (5–12 years)",    maxWeightKg: 35,   size: "3"   },
    { label: "Adolescent/Adult small",maxWeightKg: 999,  size: "4–5" }
  ],
  faceMaskNote: "A well-fitting mask covers the bridge of the nose to the cleft of the chin without overlapping the eyes or riding over the chin. In infants, a round mask (Rendell-Baker Soucek) significantly reduces dead space."
};


// =============================================================================
// SECTION 6 — FLUID DATA
// Source: 02_clinical_scope.md Module 3
// =============================================================================

const _fluidData = {

  // Holliday-Segar maintenance (§3.1)
  maintenanceFormula: {
    tiers: [
      { upToKg: 10,  ratePerKg: 4 },
      { upToKg: 20,  ratePerKg: 2 },
      { upToKg: 999, ratePerKg: 1 }
    ],
    unit: "ml/kg/hr",
    dailyEquivalent: "100/50/20 ml/kg/day",
    fluidTypeNote: "Use isotonic maintenance fluids (0.9% saline or balanced crystalloids) in all paediatric patients >1 month. Hypotonic fluids should NOT be used as default maintenance in the perioperative period.",
    intraopWarning: "The 4-2-1 rule is a maintenance ESTIMATE. Intraoperative fluid management must integrate surgical losses (see intraoperative table) and haemodynamic status. Do not apply 4-2-1 in isolation intraoperatively.",
    reference: "Holliday & Segar, Pediatrics 1957"
  },

  // Deficit replacement (§3.2)
  deficitFormula: {
    formula:    "Deficit (ml) = % Dehydration × Weight (kg) × 10",
    replacement:"Replace 50% in first hour, remaining 50% over next 8 hours (or per clinical judgement).",
    reference:  "BNF for Children; APLS 6th ed"
  },

  // Intraoperative surgical losses (§3.3)
  intraoperative: [
    { type: "Minor (superficial)",     minRate: 1, maxRate: 2, unit: "ml/kg/hr" },
    { type: "Moderate",                minRate: 2, maxRate: 4, unit: "ml/kg/hr" },
    { type: "Major (open abdominal)",  minRate: 4, maxRate: 8, unit: "ml/kg/hr" }
  ],

  // Bolus resuscitation (§3.4)
  bolus: {
    crystalloid: {
      doseMin:     10,
      doseMax:     20,
      unit:        "ml/kg",
      overMinutes: "15–30",
      maxTotal:    "40–60 ml/kg",
      notes:       "Reassess after every bolus."
    },
    colloid: {
      doseMin: 10,
      doseMax: 20,
      unit:    "ml/kg"
    },
    septicShock: {
      dose:    10,
      unit:    "ml/kg",
      notes:   "WHO/FEAST guidance — 10 ml/kg bolus then reassess. Avoid aggressive fluid loading in African paediatric sepsis. FEAST trial data applies specifically to sub-Saharan African sepsis.",
      reference: "Maitland K et al. FEAST Trial. NEJM 2011"
    },
    warning: "Fluid bolus strategy must be adapted to haemodynamic phenotype. Septic shock, hypovolaemic shock, and malaria-associated shock have different fluid responses. Clinical reassessment after every bolus is MANDATORY."
  },

  // Estimated Blood Volume by age (§3.5)
  estimatedBloodVolume: [
    { label: "Premature neonate", ebvMin: 95, ebvMax: 100, unit: "ml/kg" },
    { label: "Term neonate",      ebvMin: 85, ebvMax: 90,  unit: "ml/kg" },
    { label: "Infant (3–12 mo)",  ebvMin: 80, ebvMax: 80,  unit: "ml/kg" },
    { label: "Child (1–6 yr)",    ebvMin: 75, ebvMax: 75,  unit: "ml/kg" },
    { label: "Child (>6 yr)",     ebvMin: 70, ebvMax: 70,  unit: "ml/kg" }
  ],

  ablFormula: {
    formula:   "ABL = EBV × (Starting Hct − Minimum acceptable Hct) ÷ Starting Hct",
    reference: "Steward & Lerman, Manual of Pediatric Anesthesia 6th ed"
  },

  prcTransfusion: {
    formula:   "Volume (ml) = Weight (kg) × Desired Hb rise (g/dL) × 3",
    reference: "BNF for Children; Steward & Lerman"
  }
};


// =============================================================================
// SECTION 7 — LOCAL ANAESTHETIC DATA
// Source: 02_clinical_scope.md Module 4
// =============================================================================

const _regionalData = {

  // Maximum doses (§4.1)
  maxDoses: [
    {
      id:              "lidocaine",
      name:            "Lidocaine",
      plainMgPerKg:    3,
      withAdrMgPerKg:  7,
      warnings: [
        "Additive toxicity with other LA agents — calculate TOTAL LA dose.",
        "Dose reduction mandatory in neonates, infants <6 months, hepatic impairment, hypoalbuminaemia."
      ]
    },
    {
      id:              "bupivacaine",
      name:            "Bupivacaine",
      plainMgPerKg:    2,
      withAdrMgPerKg:  2.5,
      warnings: [
        "In infants <5 kg: apply safety buffer — consider 1.5 mg/kg as effective ceiling.",
        "Additive toxicity with other LA agents — calculate TOTAL LA dose.",
        "Dose reduction mandatory in neonates, infants <6 months, hepatic impairment, hypoalbuminaemia."
      ]
    },
    {
      id:              "levobupivacaine",
      name:            "Levobupivacaine",
      plainMgPerKg:    2,
      withAdrMgPerKg:  2.5,
      warnings: [
        "Additive toxicity with other LA agents — calculate TOTAL LA dose.",
        "Dose reduction mandatory in neonates, infants <6 months, hepatic impairment, hypoalbuminaemia."
      ]
    },
    {
      id:              "ropivacaine",
      name:            "Ropivacaine",
      plainMgPerKg:    3,
      withAdrMgPerKg:  null,   // not used with adrenaline per scope doc
      warnings: [
        "Adrenaline formulation not documented in scope — use plain dose only.",
        "Additive toxicity with other LA agents — calculate TOTAL LA dose."
      ]
    }
  ],

  lastWarning: "LAST (Local Anaesthetic Systemic Toxicity): Always calculate total dose before any block. Weight-based limits are ABSOLUTE in paediatric patients.",

  // Caudal block volumes (§4.2)
  caudalBlock: {
    volumes: [
      { level: "Sacral",   mlPerKg: 0.5  },
      { level: "Lumbar",   mlPerKg: 1.0  },
      { level: "Thoracic", mlPerKg: 1.25 }
    ],
    standardSolution: "Bupivacaine 0.25% with or without adrenaline 1:200,000",
    warning:          "Do NOT exceed total LA maximum dose even if volume formula suggests higher. Maximum dose is the binding constraint — recalculate concentration or volume accordingly.",
    reference:        "AAGBI Management of Severe Local Anaesthetic Toxicity 2010; BNF for Children"
  },

  // LAST management (§4.3)
  lastManagement: {
    drug:          "Intralipid 20%",
    bolusMlPerKg:  1.5,
    bolusOver:     "1 minute",
    infusionRate:  "0.25 ml/kg/min",
    repeatBolus:   "Up to 2× if no response",
    maxCumulative: "10 ml/kg over 30 minutes",
    reference:     "AAGBI Management of Severe Local Anaesthetic Toxicity 2010"
  }
};


// =============================================================================
// SECTION 8 — INFUSION DATA
// Source: 02_clinical_scope.md §1.7
// =============================================================================

const _infusionData = {
  formula: "Dose (mcg/kg/min) × Weight (kg) × 60 ÷ Concentration (mcg/ml) = Rate (ml/hr)",
  unitWarning: "ALWAYS confirm concentration units (mcg vs mg) before entering values. Unit confusion is one of the most common real-world infusion errors.",
  drugs: [
    {
      id:              "morphine-infusion",
      name:            "Morphine infusion",
      doseMin:         10,
      doseMax:         40,
      unit:            "mcg/kg/hr",
      concentration:   1000,   // mcg/ml (= 1 mg/ml standard)
      concentrationLabel: "1 mg/ml (standard)",
      reference:       "BNF for Children; APAGBI Pain Guidelines 2012"
    },
    {
      id:              "fentanyl-infusion",
      name:            "Fentanyl infusion",
      doseMin:         1,
      doseMax:         5,
      unit:            "mcg/kg/hr",
      concentration:   50,     // mcg/ml
      concentrationLabel: "50 mcg/ml",
      reference:       "BNF for Children; APAGBI Pain Guidelines 2012"
    },
    {
      id:              "ketamine-infusion",
      name:            "Ketamine (analgesic infusion)",
      doseMin:         0.1,
      doseMax:         0.5,
      unit:            "mg/kg/hr",
      concentration:   null,   // variable — confirm locally
      concentrationLabel: "Variable — confirm locally",
      warnings: [
        "Concentration varies by local preparation — CONFIRM before use."
      ],
      reference:       "BNF for Children"
    },
    {
      id:              "propofol-tiva",
      name:            "Propofol (TIVA)",
      doseMin:         3,
      doseMax:         12,
      unit:            "mg/kg/hr",
      concentration:   10,     // mg/ml
      concentrationLabel: "10 mg/ml",
      warnings: [
        "Induction: 6–12 mg/kg/hr. Maintenance: 3–6 mg/kg/hr.",
        "PROPOFOL INFUSION SYNDROME risk with high doses >48 hours — monitor triglycerides."
      ],
      reference:       "BNF for Children; Steward & Lerman"
    }
  ]
};


// =============================================================================
// SECTION 9 — ASSEMBLE AND FREEZE
// =============================================================================

// Initialise namespace if not already created
window.PaedSafe = window.PaedSafe || {};

// Assign config — read-only after this point
window.PaedSafe.config = Object.freeze({ ...PAEDSAFE_CONFIG });

// Assemble and deeply freeze all clinical data
window.PaedSafe.data = deepFreeze({
  drugs:         _drugs,
  emergencyDrugs: _emergencyDrugs,
  airway:        _airwayData,
  fluids:        _fluidData,
  regional:      _regionalData,
  infusions:     _infusionData
});

// Expose config separately for sw.js and manifest compatibility
// (sw.js reads PAEDSAFE_CONFIG.cacheName at install time)
window.PAEDSAFE_CONFIG = window.PaedSafe.config;

// Expose schema error (null if all good) — checked by index.html dependency guard
window.PaedSafe.schemaError = _schemaError;