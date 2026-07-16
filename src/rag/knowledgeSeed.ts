/**
 * MediConsult AI (TS) — seed clinical knowledge for the RAG index.
 *
 * Condensed, paraphrased guideline summaries + India drug-availability facts —
 * written in the system's own words, NOT copied guideline text. A seed to orient
 * reasoning, not an authority: every fact must be checked against the current
 * official guideline before clinical reliance.
 */

export interface KnowledgeEntry {
  id: string;
  title: string;
  topic: string;
  source: string;
  last_reviewed: string;
  body: string;
  kind?: "guideline" | "drug_availability";
}

export const GUIDELINES: KnowledgeEntry[] = [
  {
    id: "sepsis-ssc-2021",
    title: "Sepsis & Septic Shock — Surviving Sepsis Campaign (summary)",
    topic: "sepsis",
    source: "Surviving Sepsis Campaign 2021 (paraphrased summary)",
    last_reviewed: "2026-06",
    body: "For suspected septic shock: obtain blood cultures before antibiotics where it does not delay therapy; give broad-spectrum antibiotics promptly; begin balanced-crystalloid resuscitation guided by perfusion markers and lactate clearance rather than a fixed fluid volume. Use norepinephrine as the first-line vasopressor, targeting a mean arterial pressure around 65 mmHg. Reassess frequently; de-escalate antibiotics once cultures and sensitivities return. In immunocompromised or neutropenic patients, broaden empirically and consider antifungal cover if risk factors are present.",
  },
  {
    id: "febrile-neutropenia",
    title: "Febrile Neutropenia in cancer patients (summary)",
    topic: "neutropenia",
    source: "NCCN / IDSA febrile neutropenia guidance (paraphrased)",
    last_reviewed: "2026-06",
    body: "Fever in a neutropenic cancer patient (ANC below 0.5) is an emergency. Take cultures and start broad-spectrum anti-pseudomonal beta-lactam therapy without waiting for a source. Assess risk; high-risk patients need inpatient IV therapy. Add antifungal cover for persistent fever after several days of antibiotics or where invasive fungal infection is suspected on imaging or biomarkers. Consider granulocyte colony-stimulating factor in selected high-risk cases. Severe neutropenia plus a new fever should trigger urgent clinical review.",
  },
  {
    id: "her2-breast-metastatic",
    title: "HER2-positive metastatic breast cancer — systemic therapy (summary)",
    topic: "breast cancer",
    source: "ESMO / NCCN breast cancer guidance (paraphrased)",
    last_reviewed: "2026-06",
    body: "For HER2-positive metastatic breast cancer, dual HER2 blockade combined with a taxane is a standard first-line approach. On progression, antibody-drug conjugates targeting HER2 are preferred later-line options with strong evidence. Cardiac function should be monitored because HER2-directed agents can cause reversible cardiac dysfunction; baseline and periodic assessment of ejection fraction is advised. Treatment intent in the metastatic setting is disease control and quality of life, not cure; decisions should weigh efficacy against toxicity and the patient's goals.",
  },
  {
    id: "thrombocytopenia-transfusion",
    title: "Platelet transfusion thresholds (summary)",
    topic: "thrombocytopenia",
    source: "Transfusion medicine guidance (paraphrased)",
    last_reviewed: "2026-06",
    body: "Prophylactic platelet transfusion is commonly considered when the count falls below 10 in a stable patient, and at higher thresholds when there is active bleeding, fever/sepsis, or a planned invasive procedure. The threshold is a clinical judgement, not a fixed rule, and is raised when bleeding risk is higher. In chemotherapy-induced thrombocytopenia, follow the trend and the bleeding risk together rather than a single cutoff.",
  },
  {
    id: "aki-kdigo",
    title: "Acute Kidney Injury — staging and management (summary)",
    topic: "acute kidney injury",
    source: "KDIGO AKI guidance (paraphrased)",
    last_reviewed: "2026-06",
    body: "Acute kidney injury is staged by the rise in serum creatinine relative to baseline and by urine output. Management is largely supportive: treat the cause, optimise volume status and perfusion pressure, stop or dose-adjust nephrotoxic drugs, and avoid further insults such as contrast where feasible. Renal replacement therapy is considered for refractory fluid overload, severe electrolyte or acid-base disturbance, or uraemic complications, rather than at a fixed creatinine number. Drug doses must be recalculated for the reduced clearance.",
  },
];

// Costs are indicative and change frequently — always verify current price/stock.
export const DRUGS_INDIA: KnowledgeEntry[] = [
  {
    id: "drug-pertuzumab",
    title: "Pertuzumab — India availability",
    topic: "drug pertuzumab",
    source: "India drug-availability summary",
    last_reviewed: "2026-06",
    body: "Pertuzumab is approved and available in India as a branded HER2-directed antibody, used with trastuzumab and a taxane. It is high-cost; manufacturer patient-access and assistance programmes have historically reduced effective cost for eligible patients. A fixed-dose subcutaneous combination with trastuzumab is also available, which shortens administration time. Verify current brand, stock at the treating hospital, and any active assistance programme before planning.",
  },
  {
    id: "drug-trastuzumab",
    title: "Trastuzumab — India availability",
    topic: "drug trastuzumab",
    source: "India drug-availability summary",
    last_reviewed: "2026-06",
    body: "Trastuzumab is widely available in India, including multiple biosimilars that substantially lower cost compared with the originator. Biosimilars are approved and routinely used. Both intravenous and subcutaneous forms exist. Because several biosimilars compete, price varies by brand; the treating centre's formulary determines what is stocked.",
  },
  {
    id: "drug-tdxd",
    title: "Trastuzumab deruxtecan (T-DXd) — India availability",
    topic: "drug trastuzumab deruxtecan T-DXd antibody drug conjugate",
    source: "India drug-availability summary",
    last_reviewed: "2026-06",
    body: "Trastuzumab deruxtecan, a HER2-directed antibody-drug conjugate, is a high-efficacy later-line option in HER2-positive disease. Availability in India has been more limited and the cost is very high; access may involve named-patient import or manufacturer access programmes depending on current approval and stock. Interstitial lung disease is an important toxicity requiring monitoring. Confirm current Indian regulatory status, availability, and any access pathway before relying on it.",
  },
  {
    id: "drug-norepinephrine",
    title: "Norepinephrine — India availability",
    topic: "drug norepinephrine vasopressor",
    source: "India drug-availability summary",
    last_reviewed: "2026-06",
    body: "Norepinephrine is a widely available, low-cost generic vasopressor stocked in essentially every Indian ICU. It is the first-line vasopressor for septic shock. No access barrier.",
  },
];

/** All knowledge entries with a 'kind' tag. */
export function allEntries(): Required<KnowledgeEntry>[] {
  return [
    ...GUIDELINES.map((g) => ({ ...g, kind: "guideline" as const })),
    ...DRUGS_INDIA.map((d) => ({ ...d, kind: "drug_availability" as const })),
  ];
}
