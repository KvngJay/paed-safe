// =============================================================================
// PaedSafe — calc.js
// Calculation engine — pure functions only.
//
// RULES (from 03_technical_architecture.md):
//   - Reads from window.PaedSafe.data — NEVER writes to it
//   - No DOM access, no side effects, no internal state
//   - One function per formula — no combining
//   - Rounding at output step only (Section 9 of architecture doc)
//   - All try...catch — never throw to the UI layer
//   - Warning logic belongs here, not in index.html
//   - Additive LA toxicity tracked explicitly (§5 calc.js)
//   - Adult dose caps applied per drug (§5 calc.js)
//
// Input contract (every function):
//   { weightKg: Number, ageMonths: Number, weightSource: String }
//
// Output contract (every function):
//   { value, unit, formula, warning, reference, trace: { input, steps } }
//
// Clinical content sourced from: 02_clinical_scope.md v1.3
// Author: Dr. John Afam-Osemene
// =============================================================================

"use strict";

// =============================================================================
// SECTION 1 — ROUNDING UTILITIES
// Applied at output step only — never mid-calculation.
// Source: 03_technical_architecture.md §9
// =============================================================================

const _round1dp  = v => Math.round(v * 10)   / 10;
const _round2dp  = v => Math.round(v * 100)  / 100;

/**
 * Round ETT size to nearest 0.5 increment.
 * e.g. 4.3 → 4.5, 4.1 → 4.0
 */
const _roundEtt  = v => Math.round(v * 2) / 2;

/**
 * Select rounding rule by unit and drug context.
 * @param {number} value
 * @param {string} unit   - "mg", "mcg", "ml", "ml/hr", "mm"
 * @param {boolean} highPrecision - true for fentanyl <1 mcg/kg
 */
function _applyRounding(value, unit, highPrecision = false) {
  if (unit === "mm")    return _roundEtt(value);
  if (highPrecision)    return _round2dp(value);
  return _round1dp(value);
}


// =============================================================================
// SECTION 2 — INPUT VALIDATION
// Every calc function calls _validateInputs() before computing.
// Returns null if valid; returns warning string if invalid.
// =============================================================================

function _validateInputs({ weightKg, ageMonths }) {
  const cfg = window.PaedSafe.config;

  if (typeof weightKg !== "number" || isNaN(weightKg) || weightKg <= 0) {
    return "Enter a valid weight to calculate.";
  }
  if (typeof ageMonths !== "number" || isNaN(ageMonths) || ageMonths < 0) {
    return "Enter a valid age to calculate.";
  }
  if (weightKg > cfg.maxWeightKg) {
    return `Weight ${weightKg} kg exceeds maximum supported value (${cfg.maxWeightKg} kg). Verify entry.`;
  }
  if (ageMonths > cfg.maxAgeMonths) {
    return `Age ${ageMonths} months exceeds maximum supported value (${cfg.maxAgeMonths} months). Verify entry.`;
  }
  return null; // valid
}

/**
 * Returns true if patient is a neonate (<28 days = <1 month approximation).
 * Used to trigger persistent neonatal warning.
 */
function _isNeonate(ageMonths, weightKg) {
  return ageMonths < 1 || weightKg < 5;
}

/**
 * Assemble warning string combining neonate flag, dose ceiling checks,
 * and any drug-specific warnings.
 */
function _buildWarning({ drugWarnings = [], doseValue, maxDose, isNeonate, extraWarning = null }) {
  const parts = [];

  if (isNeonate) {
    parts.push("⚠️ NEONATE / LOW WEIGHT — verify all doses independently before administration.");
  }
  if (maxDose !== null && doseValue !== null) {
    if (doseValue > maxDose) {
      parts.push(`🔴 MAXIMUM DOSE EXCEEDED (max ${maxDose} — do not administer calculated dose. Use maximum dose only.)`);
    } else if (doseValue >= maxDose * 0.8) {
      parts.push(`⚠️ Approaching maximum dose (${maxDose}) — verify.`);
    }
  }
  if (extraWarning) parts.push(extraWarning);
  if (drugWarnings.length) parts.push(...drugWarnings);

  return parts.length ? parts.join(" | ") : null;
}

/**
 * Null-safe output shell — returned when input validation fails.
 * Conforms to the full output contract so assertShape() passes.
 */
function _invalidResult(warning, reference = "") {
  return {
    value:     null,
    unit:      "",
    formula:   "",
    warning:   warning,
    reference: reference,
    trace: { input: {}, steps: ["Input validation failed: " + warning] }
  };
}


// =============================================================================
// SECTION 3 — ADDITIVE LA TOXICITY TRACKER
// Per 03_technical_architecture.md §5:
//   "LA toxicity is additive — must be handled explicitly."
// Stored on window.PaedSafe.calc._laSession — reset per patient session
// by index.html when patient data changes.
// calc.js does NOT store patient state — only LA session accumulator,
// which is a calculation-layer concern, not patient state.
// =============================================================================

/**
 * LA session accumulator. Resets when index.html calls
 * window.PaedSafe.calc.resetLaSession().
 * Structure: { drugId: { doseMg, maxDoseMg } }
 */
let _laSession = {};

function _resetLaSession() {
  _laSession = {};
}

/**
 * Register an LA dose into the session accumulator.
 * Returns combined total and whether limit is approached/exceeded.
 *
 * @param {string} drugId
 * @param {number} doseMg       - dose calculated for this drug
 * @param {number} maxDoseMg    - this drug's absolute ceiling
 * @param {number} weightKg
 * @returns {{ totalMg, warning: string|null }}
 */
function _trackLaDose(drugId, doseMg, maxDoseMg, weightKg) {
  _laSession[drugId] = { doseMg, maxDoseMg };

  const totalMg    = Object.values(_laSession).reduce((sum, e) => sum + e.doseMg, 0);
  const totalMaxMg = Object.values(_laSession).reduce((sum, e) => sum + e.maxDoseMg, 0);

  let warning = null;
  if (totalMg > totalMaxMg) {
    warning = `🔴 COMBINED LA DOSE (${_round1dp(totalMg)} mg) EXCEEDS combined maximum (${_round1dp(totalMaxMg)} mg). LAST risk — do not proceed.`;
  } else if (totalMg >= totalMaxMg * 0.8) {
    warning = `⚠️ Combined LA dose (${_round1dp(totalMg)} mg) approaching combined maximum (${_round1dp(totalMaxMg)} mg) — verify total before block.`;
  }

  return { totalMg, warning };
}


// =============================================================================
// SECTION 4 — DRUG DOSE CALCULATOR (generic weight-based)
// Used for all drugs in the drug database.
// =============================================================================

/**
 * Calculate dose for a drug entry from window.PaedSafe.data.drugs.
 *
 * @param {string} drugId    - matches drug.id in data.js
 * @param {{ weightKg, ageMonths, weightSource }} patient
 * @returns output contract object
 */
function calcDrug(drugId, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    // Clone drug entry — never hold direct reference to frozen data
    const drug = { ...window.PaedSafe.data.drugs.find(d => d.id === drugId) };
    if (!drug || !drug.id) {
      return _invalidResult(`Drug "${drugId}" not found in clinical database.`);
    }

    const isNeonatePatient = _isNeonate(ageMonths, weightKg);

    // Calculate min and max doses
    const rawMin = drug.doseMin * weightKg;
    const rawMax = drug.doseMax * weightKg;

    // Apply adult dose cap if defined
    let cappedMin = rawMin;
    let cappedMax = rawMax;
    let capApplied = false;
    if (drug.adultCapMg && rawMax > drug.adultCapMg) {
      cappedMax  = drug.adultCapMg;
      cappedMin  = Math.min(rawMin, drug.adultCapMg);
      capApplied = true;
    }

    // Apply absolute maxDose ceiling
    let finalMax = cappedMax;
    let maxCeilingApplied = false;
    if (drug.maxDose !== null && cappedMax > drug.maxDose) {
      finalMax          = drug.maxDose;
      maxCeilingApplied = true;
    }
    let finalMin = Math.min(cappedMin, finalMax);

    // Determine display value:
    // If min === max (fixed dose), show single value. Otherwise show range.
    const isSingleDose = drug.doseMin === drug.doseMax;

    // High precision flag for fentanyl / clonidine (mcg doses <1 mcg/kg)
    const highPrecision = (drug.unit === "mcg/kg") && (drug.doseMax < 1);

    const displayMin = _applyRounding(finalMin, drug.unit.replace("/kg",""), highPrecision);
    const displayMax = _applyRounding(finalMax, drug.unit.replace("/kg",""), highPrecision);

    const formula = isSingleDose
      ? `${drug.doseMin} ${drug.unit} × ${weightKg} kg = ${displayMax} ${drug.unit.replace("/kg","")}`
      : `${drug.doseMin}–${drug.doseMax} ${drug.unit} × ${weightKg} kg = ${displayMin}–${displayMax} ${drug.unit.replace("/kg","")}`;

    // Build warning
    const extraWarnings = [];
    if (capApplied)          extraWarnings.push(`Adult dose cap applied (max ${drug.adultCapMg} mg).`);
    if (weightSource === "estimated") extraWarnings.push("⚠️ ESTIMATED WEIGHT in use — verify dose clinically.");

    const warning = _buildWarning({
      drugWarnings: drug.warnings,
      doseValue:    finalMax,
      maxDose:      drug.maxDose,
      isNeonate:    isNeonatePatient && drug.neonateFlag,
      extraWarning: extraWarnings.join(" ") || null
    });

    return {
      value:     isSingleDose ? displayMax : { min: displayMin, max: displayMax },
      unit:      drug.unit.replace("/kg", ""),
      formula,
      warning,
      reference: drug.reference,
      trace: {
        input: { weightKg, ageMonths, weightSource, drugId },
        steps: [
          `Raw dose: ${drug.doseMin}–${drug.doseMax} ${drug.unit} × ${weightKg} kg`,
          `Raw range: ${rawMin}–${rawMax}`,
          capApplied          ? `Adult cap applied: max → ${drug.adultCapMg}` : null,
          maxCeilingApplied   ? `Absolute max ceiling applied: max → ${drug.maxDose}` : null,
          `Final: ${displayMin}–${displayMax} ${drug.unit.replace("/kg","")}`
        ].filter(Boolean)
      }
    };

  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 5 — SUGAMMADEX (multi-tier dose)
// Special case: dose depends on block depth selection, not weight alone.
// =============================================================================

/**
 * @param {"moderate"|"deep"|"rsi"} blockDepth
 * @param {{ weightKg, ageMonths, weightSource }} patient
 */
function calcSugammadex(blockDepth, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const doseMap = { moderate: 2, deep: 4, rsi: 16 };
    const labelMap = {
      moderate: "Moderate block",
      deep:     "Deep block",
      rsi:      "Immediate reversal (RSI rescue)"
    };

    if (!doseMap[blockDepth]) {
      return _invalidResult(`Unknown block depth "${blockDepth}". Use: moderate, deep, or rsi.`);
    }

    const dosePerKg = doseMap[blockDepth];
    const raw       = dosePerKg * weightKg;
    const display   = _round1dp(raw);

    return {
      value:   display,
      unit:    "mg",
      formula: `${dosePerKg} mg/kg × ${weightKg} kg = ${display} mg (${labelMap[blockDepth]})`,
      warning: weightSource === "estimated"
        ? "⚠️ ESTIMATED WEIGHT — verify dose clinically. | Rocuronium/vecuronium ONLY."
        : "Rocuronium/vecuronium ONLY — not effective for other NMBAs.",
      reference: "BNF for Children (current ed); APLS 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource, blockDepth },
        steps: [
          `Block depth: ${labelMap[blockDepth]}`,
          `Dose: ${dosePerKg} mg/kg × ${weightKg} kg = ${raw} mg`,
          `Rounded: ${display} mg`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 6 — EMERGENCY DRUG CALCULATORS
// Each emergency drug has its own function per architecture rule:
// "one function per formula — no combining"
// =============================================================================

function calcAdrenalineArrest({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const doseMcg   = 10 * weightKg;          // 10 mcg/kg
    const volumeMl  = 0.1 * weightKg;         // 0.1 ml/kg of 1:10,000

    return {
      value:   { doseMcg: _round1dp(doseMcg), volumeMl: _round1dp(volumeMl) },
      unit:    "mcg / ml",
      formula: `10 mcg/kg × ${weightKg} kg = ${_round1dp(doseMcg)} mcg | 0.1 ml/kg × ${weightKg} kg = ${_round1dp(volumeMl)} ml of 1:10,000`,
      warning: "🔴 CONCENTRATION: 1:10,000 (10 mcg/ml) — IV/IO ONLY. DO NOT use 1:1,000 for IV/IO — fatal overdose risk.",
      reference: "APLS 6th ed; WHO Pocket Book of Hospital Care for Children 2013",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Dose: 10 mcg/kg × ${weightKg} kg = ${doseMcg} mcg`,
          `Volume: 0.1 ml/kg × ${weightKg} kg = ${volumeMl} ml of 1:10,000 solution`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcAdrenalineAnaphylaxis({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const doseMcg  = 10 * weightKg;
    const volumeMl = 0.01 * weightKg;         // 0.01 ml/kg of 1:1,000

    return {
      value:   { doseMcg: _round1dp(doseMcg), volumeMl: _round2dp(volumeMl) },
      unit:    "mcg / ml",
      formula: `10 mcg/kg × ${weightKg} kg = ${_round1dp(doseMcg)} mcg | 0.01 ml/kg × ${weightKg} kg = ${_round2dp(volumeMl)} ml of 1:1,000`,
      warning: "🔴 CONCENTRATION: 1:1,000 (1 mg/ml) — IM ONLY. DO NOT give 1:1,000 IV — use 1:10,000 for IV/IO arrest only.",
      reference: "APLS 6th ed; WHO Pocket Book of Hospital Care for Children 2013",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Dose: 10 mcg/kg × ${weightKg} kg = ${doseMcg} mcg`,
          `Volume: 0.01 ml/kg × ${weightKg} kg = ${volumeMl} ml of 1:1,000 solution`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcAtropineBradycardia({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const raw     = 0.02 * weightKg;
    const clamped = Math.min(Math.max(raw, 0.1), 0.5); // min 0.1 mg, max 0.5 mg
    const display = _round1dp(clamped);
    const minApplied = raw < 0.1;
    const maxApplied = raw > 0.5;

    return {
      value:   display,
      unit:    "mg",
      formula: `0.02 mg/kg × ${weightKg} kg = ${display} mg${minApplied ? " (minimum 0.1 mg applied)" : ""}${maxApplied ? " (maximum 0.5 mg applied)" : ""}`,
      warning: minApplied
        ? "Minimum dose 0.1 mg applied — below this risks paradoxical bradycardia."
        : maxApplied
          ? "Maximum dose 0.5 mg applied."
          : null,
      reference: "APLS 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Raw: 0.02 mg/kg × ${weightKg} kg = ${raw} mg`,
          `Clamped to [0.1, 0.5] mg: ${clamped} mg`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcAdenosine(dose, { weightKg, ageMonths, weightSource }) {
  // dose: 1 = first dose (0.1 mg/kg, max 6 mg)
  //       2 = second dose (0.2 mg/kg, max 12 mg)
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const doseMap = { 1: { perKg: 0.1, max: 6  },
                      2: { perKg: 0.2, max: 12 } };
    if (!doseMap[dose]) return _invalidResult(`Invalid adenosine dose number "${dose}". Use 1 or 2.`);

    const { perKg, max } = doseMap[dose];
    const raw     = perKg * weightKg;
    const capped  = Math.min(raw, max);
    const display = _round1dp(capped);
    const capApplied = raw > max;

    return {
      value:   display,
      unit:    "mg",
      formula: `${perKg} mg/kg × ${weightKg} kg = ${display} mg${capApplied ? ` (max ${max} mg applied)` : ""}`,
      warning: `Give as RAPID IV push followed immediately by saline flush. ${dose === 2 ? "Give only if 1st dose unsuccessful." : ""}`.trim(),
      reference: "APLS 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource, doseNumber: dose },
        steps: [
          `Dose ${dose}: ${perKg} mg/kg × ${weightKg} kg = ${raw} mg`,
          capApplied ? `Max cap applied: ${max} mg` : `Within maximum`,
          `Display: ${display} mg`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcGlucose({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const volumeMl = 2 * weightKg;
    const display  = _round1dp(volumeMl);

    return {
      value:   display,
      unit:    "ml",
      formula: `2 ml/kg × ${weightKg} kg = ${display} ml of 10% dextrose`,
      warning: "Use 10% dextrose (D10). LOW-RESOURCE: To make D10 from D50 — draw 1 ml D50 + add 4 ml sterile water = 5 ml D10. Recheck BGL after 15 minutes.",
      reference: "WHO Pocket Book of Hospital Care for Children 2013; APLS 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [`2 ml/kg × ${weightKg} kg = ${volumeMl} ml of D10`]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcCalciumGluconate({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const minMl = _round1dp(0.1 * weightKg);
    const maxMl = _round1dp(0.2 * weightKg);

    return {
      value:   { min: minMl, max: maxMl },
      unit:    "ml",
      formula: `0.1–0.2 ml/kg × ${weightKg} kg = ${minMl}–${maxMl} ml of 10% solution`,
      warning: "Give SLOWLY IV. Monitor ECG during administration. Use 10% solution ONLY — verify concentration before drawing up.",
      reference: "APLS 6th ed; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Min: 0.1 ml/kg × ${weightKg} kg = ${0.1 * weightKg} ml`,
          `Max: 0.2 ml/kg × ${weightKg} kg = ${0.2 * weightKg} ml`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcSodiumBicarbonate({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const minMmol = _round1dp(1 * weightKg);
    const maxMmol = _round1dp(2 * weightKg);
    const isNeonatePatient = _isNeonate(ageMonths, weightKg);

    return {
      value:   { min: minMmol, max: maxMmol },
      unit:    "mmol",
      formula: `1–2 mmol/kg × ${weightKg} kg = ${minMmol}–${maxMmol} mmol`,
      warning: isNeonatePatient
        ? "🔴 NEONATE: Dilute 1:1 with water for injection before administration. Give slowly."
        : "Give slowly. Use only with evidence of severe metabolic acidosis.",
      reference: "APLS 6th ed; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Min: 1 mmol/kg × ${weightKg} kg = ${minMmol} mmol`,
          `Max: 2 mmol/kg × ${weightKg} kg = ${maxMmol} mmol`,
          isNeonatePatient ? "Neonate flag: dilution warning applied" : "Standard warning applied"
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 7 — AIRWAY CALCULATORS
// Source: 02_clinical_scope.md Module 2
// =============================================================================

function calcEtt({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const ageYears = ageMonths / 12;
    const isInfant = ageYears < 1;
    const steps    = [];
    let uncuffedId, cuffedId, oralLength, nasalLength;

    if (isInfant) {
      // Weight-based for infants <1 year
      oralLength  = _round1dp(weightKg + 6);
      uncuffedId  = null;   // formula unreliable — use clinical sizing
      cuffedId    = null;
      steps.push(`Infant (<1 yr): ETT length (oral) = weight + 6 = ${weightKg} + 6 = ${oralLength} cm`);
      steps.push("ETT ID: use clinical sizing — age-based formula unreliable in infants.");
      if (ageMonths < 1) steps.push("Neonate (~3 kg): 9 cm at lip as starting point.");
    } else {
      uncuffedId  = _roundEtt((ageYears / 4) + 4);
      cuffedId    = _roundEtt((ageYears / 4) + 3.5);
      oralLength  = _round1dp((ageYears / 2) + 12);
      nasalLength = _round1dp((ageYears / 2) + 15);
      steps.push(`Age: ${ageYears.toFixed(1)} yr`);
      steps.push(`Uncuffed ID: (${ageYears.toFixed(1)} ÷ 4) + 4 = ${uncuffedId} mm`);
      steps.push(`Cuffed ID: (${ageYears.toFixed(1)} ÷ 4) + 3.5 = ${cuffedId} mm`);
      steps.push(`Oral length: (${ageYears.toFixed(1)} ÷ 2) + 12 = ${oralLength} cm`);
      steps.push(`Nasal length: (${ageYears.toFixed(1)} ÷ 2) + 15 = ${nasalLength} cm`);
    }

    const suctionUncuffed = uncuffedId ? _round1dp(uncuffedId * 2) : null;
    const suctionCuffed   = cuffedId   ? _round1dp(cuffedId   * 2) : null;

    return {
      value: {
        uncuffedId,
        cuffedId,
        oralLength,
        nasalLength: nasalLength || null,
        suctionCatheterUncuffed: suctionUncuffed,
        suctionCatheterCuffed:   suctionCuffed,
        isInfant
      },
      unit:    "mm / cm",
      formula: isInfant
        ? `ETT length (oral) = weight + 6 = ${weightKg} + 6 = ${oralLength} cm`
        : `Uncuffed: (age÷4)+4 = ${uncuffedId} mm | Cuffed: (age÷4)+3.5 = ${cuffedId} mm | Oral: (age÷2)+12 = ${oralLength} cm`,
      warning: "Estimates only — confirm placement with leak test (uncuffed) or cuff pressure monitoring and capnography. Always have one size above and one size below ready.",
      reference: "BNF for Children; Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
      trace: { input: { weightKg, ageMonths, weightSource }, steps }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcLma({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const lmaTable = window.PaedSafe.data.airway.lma;
    const entry = lmaTable.find(row => weightKg <= row.maxWeightKg);

    if (!entry) {
      return _invalidResult(`Weight ${weightKg} kg exceeds LMA sizing table — consult adult sizing.`);
    }

    return {
      value:   { size: entry.size, maxCuffMl: entry.maxCuffMl },
      unit:    "",
      formula: `Weight ${weightKg} kg → LMA size ${entry.size} (max cuff volume ${entry.maxCuffMl} ml)`,
      warning: null,
      reference: "BNF for Children; Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [`Weight ${weightKg} kg matches LMA size ${entry.size} (up to ${entry.maxWeightKg} kg)`]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcFaceMask({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const maskTable = window.PaedSafe.data.airway.faceMask;
    const entry = maskTable.find(row => weightKg <= row.maxWeightKg);

    if (!entry) {
      return _invalidResult(`Weight ${weightKg} kg exceeds face mask sizing table.`);
    }

    return {
      value:   entry.size,
      unit:    "",
      formula: `Weight ${weightKg} kg (${entry.label}) → Mask size ${entry.size}`,
      warning: window.PaedSafe.data.airway.faceMaskNote,
      reference: "02_clinical_scope.md §2.5; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [`Weight ${weightKg} kg → ${entry.label} → Mask size ${entry.size}`]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcLaryngoscope({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const ageYears = ageMonths / 12;
    const bladeTable = window.PaedSafe.data.airway.laryngoscope;

    let entry;
    if (ageYears < 1)       entry = bladeTable[0];
    else if (ageYears <= 2) entry = bladeTable[1];
    else if (ageYears <= 8) entry = bladeTable[2];
    else                    entry = bladeTable[3];

    return {
      value:   { type: entry.type, size: entry.size },
      unit:    "",
      formula: `Age ${ageYears.toFixed(1)} yr (${entry.label}) → ${entry.type}, size ${entry.size}`,
      warning: null,
      reference: "APLS 6th ed; Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [`Age ${ageYears.toFixed(1)} yr → ${entry.label} → ${entry.type} size ${entry.size}`]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 8 — FLUID CALCULATORS
// Source: 02_clinical_scope.md Module 3
// =============================================================================

function calcMaintenance({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    // Holliday-Segar 4-2-1
    let rate = 0;
    const steps = [];

    if (weightKg <= 10) {
      rate = 4 * weightKg;
      steps.push(`≤10 kg: 4 ml/kg/hr × ${weightKg} kg = ${rate} ml/hr`);
    } else if (weightKg <= 20) {
      rate = 40 + 2 * (weightKg - 10);
      steps.push(`10–20 kg: 40 + 2 × (${weightKg} - 10) = ${rate} ml/hr`);
    } else {
      rate = 60 + 1 * (weightKg - 20);
      steps.push(`>20 kg: 60 + 1 × (${weightKg} - 20) = ${rate} ml/hr`);
    }

    const dailyMl = _round1dp(rate * 24);
    const display = _round1dp(rate);

    return {
      value:   display,
      unit:    "ml/hr",
      formula: `Holliday-Segar (4-2-1): ${display} ml/hr | Daily: ${dailyMl} ml/day`,
      warning: "4-2-1 is a MAINTENANCE estimate. Intraoperative use must integrate surgical losses and haemodynamic status — do not apply 4-2-1 in isolation intraoperatively. Use isotonic fluids (0.9% saline or balanced crystalloid).",
      reference: "Holliday & Segar, Pediatrics 1957",
      trace: { input: { weightKg, ageMonths, weightSource }, steps }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcDeficit(dehydrationPercent, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    if (typeof dehydrationPercent !== "number" || dehydrationPercent <= 0 || dehydrationPercent > 15) {
      return _invalidResult("Enter dehydration percentage (1–15%) to calculate deficit.");
    }

    const totalMl   = dehydrationPercent * weightKg * 10;
    const firstHr   = _round1dp(totalMl * 0.5);
    const next8hr   = _round1dp(totalMl * 0.5);
    const displayTotal = _round1dp(totalMl);

    return {
      value:   { total: displayTotal, firstHour: firstHr, next8Hours: next8hr },
      unit:    "ml",
      formula: `${dehydrationPercent}% × ${weightKg} kg × 10 = ${displayTotal} ml total | First hour: ${firstHr} ml | Next 8 hr: ${next8hr} ml`,
      warning: "Replace 50% in first hour, remaining 50% over next 8 hours — adjust per clinical response.",
      reference: "BNF for Children; APLS 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource, dehydrationPercent },
        steps: [
          `Total deficit: ${dehydrationPercent}% × ${weightKg} × 10 = ${totalMl} ml`,
          `50% first hour: ${firstHr} ml`,
          `50% over 8 hours: ${next8hr} ml`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcBolus(fluidType, { weightKg, ageMonths, weightSource }) {
  // fluidType: "crystalloid" | "colloid" | "sepsis"
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const map = {
      crystalloid: { min: 10, max: 20, note: "Over 15–30 min. Reassess. Max 40–60 ml/kg total." },
      colloid:     { min: 10, max: 20, note: "Colloid bolus — reassess after each." },
      sepsis:      { min: 10, max: 10, note: "WHO/FEAST guidance: 10 ml/kg then REASSESS. Avoid aggressive fluid loading in African paediatric sepsis." }
    };

    if (!map[fluidType]) return _invalidResult(`Unknown fluid type "${fluidType}".`);

    const { min, max, note } = map[fluidType];
    const minMl = _round1dp(min * weightKg);
    const maxMl = _round1dp(max * weightKg);

    return {
      value:   fluidType === "sepsis" ? minMl : { min: minMl, max: maxMl },
      unit:    "ml",
      formula: fluidType === "sepsis"
        ? `10 ml/kg × ${weightKg} kg = ${minMl} ml`
        : `${min}–${max} ml/kg × ${weightKg} kg = ${minMl}–${maxMl} ml`,
      warning: `${note} Fluid bolus strategy must be adapted to haemodynamic phenotype — reassessment after every bolus is MANDATORY.`,
      reference: "APLS 6th ed; Maitland K et al. FEAST Trial. NEJM 2011; WHO Pocket Book 2013",
      trace: {
        input: { weightKg, ageMonths, weightSource, fluidType },
        steps: [
          `Type: ${fluidType}`,
          `Min: ${min} ml/kg × ${weightKg} = ${min * weightKg} ml`,
          `Max: ${max} ml/kg × ${weightKg} = ${max * weightKg} ml`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcAbl(startingHct, minHct, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    if (typeof startingHct !== "number" || startingHct <= 0 || startingHct > 70) {
      return _invalidResult("Enter starting haematocrit (%) to calculate ABL.");
    }
    if (typeof minHct !== "number" || minHct <= 0 || minHct >= startingHct) {
      return _invalidResult("Minimum acceptable haematocrit must be less than starting haematocrit.");
    }

    // EBV lookup by age
    const ebvTable = window.PaedSafe.data.fluids.estimatedBloodVolume;
    const ageYears = ageMonths / 12;
    let ebvPerKg;

    if (ageMonths < 1)       ebvPerKg = 90;   // term neonate midpoint
    else if (ageYears < 1)   ebvPerKg = 80;   // infant
    else if (ageYears <= 6)  ebvPerKg = 75;   // child 1–6 yr
    else                     ebvPerKg = 70;   // child >6 yr

    const ebv  = ebvPerKg * weightKg;
    const abl  = ebv * (startingHct - minHct) / startingHct;
    const displayEbv = _round1dp(ebv);
    const displayAbl = _round1dp(abl);

    return {
      value:   { ebv: displayEbv, abl: displayAbl, ebvPerKg },
      unit:    "ml",
      formula: `EBV = ${ebvPerKg} ml/kg × ${weightKg} kg = ${displayEbv} ml | ABL = ${displayEbv} × (${startingHct} − ${minHct}) ÷ ${startingHct} = ${displayAbl} ml`,
      warning: "ABL is an estimate — monitor haemoglobin/haematocrit intraoperatively and trigger transfusion per clinical picture, not ABL alone.",
      reference: "Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource, startingHct, minHct },
        steps: [
          `Age ${ageYears.toFixed(1)} yr → EBV ${ebvPerKg} ml/kg`,
          `EBV = ${ebvPerKg} × ${weightKg} = ${ebv} ml`,
          `ABL = ${ebv} × (${startingHct} - ${minHct}) / ${startingHct} = ${abl} ml`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

function calcPrcVolume(desiredHbRise, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    if (typeof desiredHbRise !== "number" || desiredHbRise <= 0 || desiredHbRise > 10) {
      return _invalidResult("Enter desired Hb rise (g/dL) to calculate transfusion volume.");
    }

    const raw     = weightKg * desiredHbRise * 3;
    const display = _round1dp(raw);

    return {
      value:   display,
      unit:    "ml",
      formula: `${weightKg} kg × ${desiredHbRise} g/dL × 3 = ${display} ml packed red cells`,
      warning: "Transfuse over 3–4 hours unless haemodynamically compromised. Reassess Hb after transfusion.",
      reference: "BNF for Children; Steward & Lerman, Manual of Pediatric Anesthesia 6th ed",
      trace: {
        input: { weightKg, ageMonths, weightSource, desiredHbRise },
        steps: [`${weightKg} × ${desiredHbRise} × 3 = ${raw} ml`]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 9 — REGIONAL / LOCAL ANAESTHETIC CALCULATORS
// Source: 02_clinical_scope.md Module 4
// =============================================================================

/**
 * Calculate maximum safe LA dose, track additive toxicity.
 * @param {string} drugId       - "lidocaine" | "bupivacaine" | "levobupivacaine" | "ropivacaine"
 * @param {boolean} withAdr     - with adrenaline?
 * @param {{ weightKg, ageMonths, weightSource }} patient
 */
function calcLaMax(drugId, withAdr, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const laTable = window.PaedSafe.data.regional.maxDoses;
    const drug    = { ...laTable.find(d => d.id === drugId) };
    if (!drug || !drug.id) return _invalidResult(`LA drug "${drugId}" not found.`);

    const dosePerKg = withAdr ? drug.withAdrMgPerKg : drug.plainMgPerKg;
    if (dosePerKg === null) {
      return _invalidResult(`${drug.name} with adrenaline dose not documented — use plain dose only.`);
    }

    // Infant <5 kg: bupivacaine safety buffer (1.5 mg/kg ceiling)
    let effectiveDosePerKg = dosePerKg;
    let bufferApplied = false;
    if (drugId === "bupivacaine" && weightKg < 5) {
      effectiveDosePerKg = Math.min(dosePerKg, 1.5);
      bufferApplied = true;
    }

    const maxDoseMg = effectiveDosePerKg * weightKg;
    const display   = _round1dp(maxDoseMg);

    // Additive LA tracking
    const { totalMg, warning: laWarning } = _trackLaDose(drugId, maxDoseMg, maxDoseMg, weightKg);

    const warnings = [...drug.warnings];
    if (bufferApplied) warnings.unshift(`⚠️ Infant <5 kg: bupivacaine safety buffer applied — ceiling reduced to 1.5 mg/kg (${_round1dp(1.5 * weightKg)} mg).`);
    if (laWarning)     warnings.unshift(laWarning);
    if (_isNeonate(ageMonths, weightKg)) warnings.unshift("🔴 NEONATE/LOW WEIGHT: Dose reduction mandatory — increased free drug fraction lowers effective toxicity threshold.");

    return {
      value:   display,
      unit:    "mg",
      formula: `${effectiveDosePerKg} mg/kg × ${weightKg} kg = ${display} mg (${drug.name}${withAdr ? " + adrenaline" : ", plain"})`,
      warning: warnings.join(" | "),
      reference: "AAGBI Management of Severe Local Anaesthetic Toxicity 2010; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource, drugId, withAdr },
        steps: [
          `${drug.name} ${withAdr ? "with adrenaline" : "plain"}: ${dosePerKg} mg/kg`,
          bufferApplied ? `Infant <5 kg buffer: capped at 1.5 mg/kg` : null,
          `Max dose: ${effectiveDosePerKg} × ${weightKg} = ${maxDoseMg} mg`,
          `Session LA total: ${_round1dp(totalMg)} mg`
        ].filter(Boolean)
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

/**
 * Caudal block volume calculator.
 * @param {"sacral"|"lumbar"|"thoracic"} level
 */
function calcCaudal(level, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const volumeMap = { sacral: 0.5, lumbar: 1.0, thoracic: 1.25 };
    if (!volumeMap[level]) return _invalidResult(`Unknown caudal level "${level}". Use: sacral, lumbar, or thoracic.`);

    const mlPerKg  = volumeMap[level];
    const raw      = mlPerKg * weightKg;
    const display  = _round1dp(raw);

    // Cross-check against bupivacaine 0.25% max dose
    // 0.25% = 2.5 mg/ml. Max bupivacaine plain = 2 mg/kg
    const bupMaxMg = 2 * weightKg;
    const bupInVolume = display * 2.5; // mg in calculated volume at 0.25%
    const exceedsBupMax = bupInVolume > bupMaxMg;

    const warnings = [
      "Do NOT exceed total LA maximum dose even if volume formula suggests higher — maximum dose is the binding constraint.",
      "Standard solution: bupivacaine 0.25% ± adrenaline 1:200,000."
    ];

    if (exceedsBupMax) {
      warnings.unshift(`🔴 Calculated volume (${display} ml) of bupivacaine 0.25% = ${_round1dp(bupInVolume)} mg, which EXCEEDS max dose of ${_round1dp(bupMaxMg)} mg. Reduce volume or use lower concentration.`);
    }

    return {
      value:   display,
      unit:    "ml",
      formula: `${mlPerKg} ml/kg × ${weightKg} kg = ${display} ml (${level} level)`,
      warning: warnings.join(" | "),
      reference: "AAGBI Management of Severe Local Anaesthetic Toxicity 2010; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource, level },
        steps: [
          `Level: ${level} → ${mlPerKg} ml/kg`,
          `Volume: ${mlPerKg} × ${weightKg} = ${raw} ml`,
          `Bupivacaine 0.25% check: ${_round1dp(bupInVolume)} mg vs max ${_round1dp(bupMaxMg)} mg`,
          exceedsBupMax ? "⚠️ Max dose exceeded by volume — reduce volume" : "Volume within bupivacaine max dose"
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

/**
 * Intralipid rescue for LAST.
 */
function calcIntralipid({ weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    const bolusMl    = _round1dp(1.5  * weightKg);
    const infusionMl = _round2dp(0.25 * weightKg);  // ml/kg/min — keep 2dp for precision
    const maxMl      = _round1dp(10   * weightKg);

    return {
      value: { bolusMl, infusionMlPerMin: infusionMl, maxCumulativeMl: maxMl },
      unit:  "ml",
      formula: `Bolus: 1.5 ml/kg × ${weightKg} kg = ${bolusMl} ml over 1 min | Infusion: 0.25 ml/kg/min × ${weightKg} kg = ${infusionMl} ml/min | Max: 10 ml/kg = ${maxMl} ml`,
      warning: "Intralipid 20% ONLY. Repeat bolus up to 2× if no response. Do NOT exceed 10 ml/kg cumulative. Continue CPR throughout. Call for senior help immediately.",
      reference: "AAGBI Management of Severe Local Anaesthetic Toxicity 2010",
      trace: {
        input: { weightKg, ageMonths, weightSource },
        steps: [
          `Bolus: 1.5 × ${weightKg} = ${1.5 * weightKg} ml`,
          `Infusion: 0.25 × ${weightKg} = ${0.25 * weightKg} ml/min`,
          `Max cumulative: 10 × ${weightKg} = ${10 * weightKg} ml`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 10 — INFUSION RATE CALCULATOR
// Source: 02_clinical_scope.md §1.7
// Formula: Dose (mcg/kg/min) × Weight (kg) × 60 ÷ Concentration (mcg/ml) = Rate (ml/hr)
// =============================================================================

/**
 * Generic infusion rate calculator.
 * @param {number} doseMcgKgMin     - desired dose in mcg/kg/min
 * @param {number} concentrationMcgMl - drug concentration in mcg/ml
 * @param {{ weightKg, ageMonths, weightSource }} patient
 */
function calcInfusionRate(doseMcgKgMin, concentrationMcgMl, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    if (typeof doseMcgKgMin !== "number" || doseMcgKgMin <= 0) {
      return _invalidResult("Enter a valid dose (mcg/kg/min) to calculate infusion rate.");
    }
    if (typeof concentrationMcgMl !== "number" || concentrationMcgMl <= 0) {
      return _invalidResult("Enter a valid concentration (mcg/ml) to calculate infusion rate.");
    }

    const rateMlHr = (doseMcgKgMin * weightKg * 60) / concentrationMcgMl;
    const display  = _round1dp(rateMlHr);

    return {
      value:   display,
      unit:    "ml/hr",
      formula: `${doseMcgKgMin} mcg/kg/min × ${weightKg} kg × 60 ÷ ${concentrationMcgMl} mcg/ml = ${display} ml/hr`,
      warning: "⚠️ ALWAYS confirm concentration units (mcg vs mg) before entering values. Unit confusion is one of the most common infusion errors.",
      reference: "BNF for Children; 02_clinical_scope.md §1.7",
      trace: {
        input: { weightKg, ageMonths, weightSource, doseMcgKgMin, concentrationMcgMl },
        steps: [
          `(${doseMcgKgMin} × ${weightKg} × 60) ÷ ${concentrationMcgMl}`,
          `= ${doseMcgKgMin * weightKg * 60} ÷ ${concentrationMcgMl}`,
          `= ${rateMlHr} ml/hr → rounded: ${display} ml/hr`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}


// =============================================================================
// SECTION 11 — WEECH WEIGHT ESTIMATOR
// Source: Weech AA. Pediatrics 1954 (age-based weight estimation formula)
// Three age bands — returns estimated weight and formula string.
// weightSource is ALWAYS "estimated" when this function result is used.
// =============================================================================

/**
 * Estimate weight using Weech formula.
 * @param {number} ageMonths - age in completed months
 * @returns {{ value: number|null, formula: string, band: string, reference: string, warning: string }}
 */
function calcWeechWeight(ageMonths) {
  try {
    if (typeof ageMonths !== "number" || isNaN(ageMonths) || ageMonths < 0) {
      return { value: null, formula: "", band: "", reference: "", warning: "Enter age to estimate weight." };
    }

    const ageYears = ageMonths / 12;

    if (ageMonths < 12) {
      // Infants 0–11 completed months
      const weight = (ageMonths + 9) / 2;
      return {
        value:     Math.round(weight * 10) / 10,
        formula:   `(${ageMonths} + 9) ÷ 2 = ${(Math.round(weight * 10) / 10)} kg`,
        band:      "Infant (0–11 months)",
        reference: "Weech AA. Pediatrics 1954",
        warning:   "ESTIMATED weight from Weech formula — verify actual weight before use."
      };
    } else if (ageYears < 7) {
      // Children 1–6 years
      const weight = (ageYears * 2) + 8;
      return {
        value:     Math.round(weight * 10) / 10,
      formula:   `(${ageYears.toFixed(1)} × 2) + 8 = ${(Math.round(weight * 10) / 10)} kg`,
        band:      "Child (1–6 years)",
        reference: "Weech AA. Pediatrics 1954",
        warning:   "ESTIMATED weight from Weech formula — verify actual weight before use."
      };
    } else if (ageYears <= 12) {
      // Children 7–12 years
      const weight = ((ageYears * 7) - 5) / 2;
      return {
        value:     Math.round(weight * 10) / 10,
        formula:   `((${Math.floor(ageYears)} × 7) − 5) ÷ 2 = ${(Math.round(weight * 10) / 10)} kg`,
        band:      "Child (7–12 years)",
        reference: "Weech AA. Pediatrics 1954",
        warning:   "ESTIMATED weight from Weech formula — verify actual weight before use."
      };
    } else {
      return {
        value:     null,
        formula:   "",
        band:      "",
        reference: "Weech AA. Pediatrics 1954",
        warning:   "Weech formula not valid for age >12 years — enter actual weight."
      };
    }
  } catch (e) {
    return { value: null, formula: "", band: "", reference: "", warning: "Weech calculation error — enter weight manually." };
  }
}
// =============================================================================
// SECTION 11b — FASTING DEFICIT CALCULATOR
// Formula: hours fasted × maintenance rate (ml/hr)
// Replacement: 50% in first hour, 50% over next 2 hours
// Max hours fasted: 8
// =============================================================================

function calcFastingDeficit(hoursFasted, { weightKg, ageMonths, weightSource }) {
  try {
    const validationError = _validateInputs({ weightKg, ageMonths });
    if (validationError) return _invalidResult(validationError);

    if (typeof hoursFasted !== "number" || hoursFasted <= 0 || hoursFasted > 8) {
      return _invalidResult("Enter hours fasted (1–8) to calculate fasting deficit.");
    }

    // Calculate maintenance rate first (Holliday-Segar)
    let maintenanceRate = 0;
    if (weightKg <= 10) {
      maintenanceRate = 4 * weightKg;
    } else if (weightKg <= 20) {
      maintenanceRate = 40 + 2 * (weightKg - 10);
    } else {
      maintenanceRate = 60 + 1 * (weightKg - 20);
    }

    const totalMl     = _round1dp(hoursFasted * maintenanceRate);
    const firstHrMl   = _round1dp(totalMl * 0.5);
    const next2HrRate = _round1dp((totalMl * 0.5) / 2);

    return {
      value:   { totalMl, firstHourMl: firstHrMl, next2HrRate },
      unit:    "ml",
      formula: `${hoursFasted} hrs × ${_round1dp(maintenanceRate)} ml/hr = ${totalMl} ml total | First hour: ${firstHrMl} ml | Next 2 hrs: ${next2HrRate} ml/hr`,
      warning: "Replace 50% in first hour, remaining 50% over next 2 hours — adjust per clinical response. Max 8 hours entered.",
      reference: "Holliday & Segar, Pediatrics 1957; BNF for Children",
      trace: {
        input: { weightKg, ageMonths, weightSource, hoursFasted },
        steps: [
          `Maintenance rate (4-2-1): ${_round1dp(maintenanceRate)} ml/hr`,
          `Total deficit: ${hoursFasted} × ${_round1dp(maintenanceRate)} = ${totalMl} ml`,
          `50% first hour: ${firstHrMl} ml`,
          `50% over next 2 hrs: ${next2HrRate} ml/hr`
        ]
      }
    };
  } catch (e) {
    return _invalidResult("Calculation error — re-enter patient data.");
  }
}

// =============================================================================
// SECTION 12 — ASSEMBLE ON NAMESPACE
// =============================================================================

window.PaedSafe        = window.PaedSafe || {};
window.PaedSafe.calc   = Object.freeze({

  // Drug dosing
  drug:                 calcDrug,
  sugammadex:           calcSugammadex,

  // Emergency
  adrenalineArrest:     calcAdrenalineArrest,
  adrenalineAnaphylaxis:calcAdrenalineAnaphylaxis,
  atropineBradycardia:  calcAtropineBradycardia,
  adenosine:            calcAdenosine,
  glucose:              calcGlucose,
  calciumGluconate:     calcCalciumGluconate,
  sodiumBicarbonate:    calcSodiumBicarbonate,

  // Airway
  ett:                  calcEtt,
  lma:                  calcLma,
  faceMask:             calcFaceMask,
  laryngoscope:         calcLaryngoscope,

  // Fluids
  maintenance:          calcMaintenance,
  deficit:              calcDeficit,
  bolus:                calcBolus,
  abl:                  calcAbl,
  prcVolume:            calcPrcVolume,

  // Regional
  laMax:                calcLaMax,
  caudal:               calcCaudal,
  intralipid:           calcIntralipid,

  // Infusions
  infusionRate:         calcInfusionRate,

  // Weight estimation
  weechWeight:          calcWeechWeight,
  fastingDeficit:       calcFastingDeficit,

  // LA session management (called by index.html on patient reset)
  resetLaSession:       _resetLaSession

});