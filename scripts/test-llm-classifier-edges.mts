import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function classify(
  employees: Array<{ name: string; title: string }>,
  jobs: Array<{ title: string }>,
  companyName: string,
  employeeCount: number | null,
) {
  const empList = employees.map((e) => `- ${e.name}: ${e.title}`).join("\n");
  const jobList = jobs.length ? jobs.map((j) => `- ${j.title}`).join("\n") : "None";

  const prompt = `You are classifying the sales team at ${companyName} (${employeeCount || "unknown"} employees).

EMPLOYEES:
${empList || "None found"}

OPEN JOBS:
${jobList}

TASK: Identify everyone in a NEW BUSINESS SALES role — people who generate pipeline or close new deals.

CLASSIFICATION RULES:

"ae" — anyone whose primary job is selling or closing new business:
  - Account Executive, Sales Rep, Sales Consultant
  - At companies under 75 employees, "Sales Director", "VP Sales", "CRO", "Head of Sales" are almost always ICs who sell, NOT managers. Classify them as "ae".
  - "Channel Account Executive", "Channel Sales", "Partner Sales" = ae
  - "Business Development Manager" at a small company = ae (they're selling)
  - When in doubt at a small company: if the title has "sales" in it and there's no one below them, they're an ae.

"sdr" — anyone whose primary job is outbound prospecting or appointment setting:
  - SDR, BDR, Sales Development Rep, Business Development Representative
  - NOT "Business Development Manager" or "Director of Business Development" (those are ae-level)

"sales_leader" — a TRUE people manager overseeing other salespeople. ALL THREE must be true:
  (a) Their title implies management (VP Sales, CRO, Head of Sales, Sales Director)
  (b) There are at least 2 AEs visible in the employee list below them
  (c) The company has 75+ employees
  If ANY condition fails, classify them as "ae" instead. This is strict — most companies in our pipeline are under 75 people, so sales_leader should be RARE.

"founder_seller" — Founder/CEO/President who is selling:
  - Only if the company has fewer than 30 employees
  - Only if they appear to be the primary or sole seller (no AE team visible)
  - At 30+ employees, do NOT classify founders as sellers unless they explicitly have a sales-related title

NOT SALES (ignore completely):
  - Customer Success, Account Manager, Implementation, Onboarding
  - Partnerships, Strategic Alliances, Business Development focused on partnerships
  - Sales Engineer, Solutions Consultant, Pre-Sales, Demo Specialist
  - Sales Enablement, Revenue Operations, Sales Operations
  - Marketing, Product, Engineering, Design, HR, Finance, Legal, Operations

SUMMARY FORMAT:
Write exactly one sentence describing the sales org for an AE at a sales outsourcing agency to read before calling.
- List sellers by count and name: "2 AEs (Alex Thorson, Joshua Burt), no SDRs."
- If there's a sales leader, mention them separately: "VP Sales (Maria Chen) leads 3 AEs, 2 SDRs."
- Do NOT mix leaders into the AE count in the summary text.
- If hiring: append "Hiring [role]."
- If no sales team: "No identifiable sales team on LinkedIn."
- Do NOT say "founder-led" unless a founder is literally the only person selling.
- Keep it under 120 characters when possible.

Return a JSON object:
{
  "sellers": [{ "name": "string", "title": "their actual title", "role": "ae|sdr|sales_leader|founder_seller" }],
  "ae_count": number (count of "ae" roles only — do NOT include sales_leader or founder_seller),
  "sdr_count": number,
  "has_sales_leadership": boolean (true only if at least one sales_leader exists),
  "founder_selling": boolean,
  "hiring_sdr": boolean,
  "hiring_ae": boolean,
  "hiring_sales": boolean (true if any sales-related job posting),
  "summary": "string"
}

Return ONLY valid JSON. No markdown fences, no explanation.`;

  const r = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = r.content[0];
  if (text.type !== "text") throw new Error("No text");
  const clean = text.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(clean);
}

// =====================================================
// EDGE CASES
// =====================================================

const tests: Array<{
  name: string;
  expect: string;
  company: string;
  size: number | null;
  employees: Array<{ name: string; title: string }>;
  jobs: Array<{ title: string }>;
}> = [

  // --- TITLE INFLATION ---
  {
    name: "1. Title inflation at tiny company (15 ppl)",
    expect: "Both should be AEs, not leadership. Founder selling.",
    company: "TinyEdTech", size: 15,
    employees: [
      { name: "Jane Smith", title: "Chief Revenue Officer" },
      { name: "Bob Lee", title: "VP of Sales & Partnerships" },
      { name: "founder mike", title: "CEO & Founder" },
    ],
    jobs: [],
  },

  // --- CS / ACCOUNT MGMT confusion ---
  {
    name: "2. Customer Success ≠ Sales",
    expect: "Only Parker is selling. CS/AM roles should NOT count.",
    company: "CurriculumCo", size: 40,
    employees: [
      { name: "Parker James", title: "Account Executive" },
      { name: "Lisa Chen", title: "Customer Success Manager" },
      { name: "Amy Torres", title: "Account Manager" },
      { name: "Kevin Wu", title: "Director of Customer Success" },
      { name: "Sam Patel", title: "Head of Partnerships" },
    ],
    jobs: [],
  },

  // --- ZERO sales people found ---
  {
    name: "3. No sales team at all (pure product company)",
    expect: "No sellers. Summary should say 'No identifiable sales team.'",
    company: "DevToolsCo", size: 25,
    employees: [
      { name: "Alice R", title: "Software Engineer" },
      { name: "Bob T", title: "Product Manager" },
      { name: "Carol U", title: "Designer" },
      { name: "Dave V", title: "CTO & Co-founder" },
    ],
    jobs: [],
  },

  // --- ONLY hiring signals, no current employees ---
  {
    name: "4. No current sales team but hiring for sales",
    expect: "No current sellers, but hiring_ae and hiring_sdr should be true.",
    company: "GrowthStartup", size: 20,
    employees: [
      { name: "Founder Jen", title: "CEO" },
      { name: "Mark H", title: "Head of Product" },
    ],
    jobs: [
      { title: "Account Executive - K12" },
      { title: "Sales Development Representative" },
    ],
  },

  // --- BIZ DEV ambiguity ---
  {
    name: "5. 'Business Development' titles — are they SDRs or partnership roles?",
    expect: "BD Manager at a 30-person company = probably selling. BD Rep = SDR.",
    company: "EdPlatform", size: 30,
    employees: [
      { name: "Tom Green", title: "Business Development Manager" },
      { name: "Sara White", title: "Business Development Representative" },
      { name: "Jim Black", title: "Director of Business Development" },
    ],
    jobs: [],
  },

  // --- REAL hierarchy at scale ---
  {
    name: "6. Large company (200 ppl) with real hierarchy",
    expect: "VP Sales = leader. Directors = AEs or mid-mgmt. SDRs correctly counted.",
    company: "ScaleEdTech", size: 200,
    employees: [
      { name: "Maria VP", title: "VP of Sales" },
      { name: "RepB Dir", title: "Director of Sales, West" },
      { name: "Kate Dir", title: "Director of Sales, East" },
      { name: "AE One", title: "Senior Account Executive" },
      { name: "AE Two", title: "Account Executive" },
      { name: "AE Three", title: "Account Executive" },
      { name: "SDR One", title: "Sales Development Representative" },
      { name: "SDR Two", title: "SDR" },
      { name: "SDR Three", title: "BDR" },
    ],
    jobs: [],
  },

  // --- SINGLE founder, large-ish company ---
  {
    name: "7. Founder at 45-person company — should NOT be classified as founder_seller",
    expect: "Founder at 45 people is probably NOT the primary seller. Don't assume.",
    company: "MidSizeEd", size: 45,
    employees: [
      { name: "Founder Pat", title: "CEO & Founder" },
      { name: "Nobody Else", title: "VP of Engineering" },
    ],
    jobs: [],
  },

  // --- CHANNEL / PARTNER sales ---
  {
    name: "8. Channel sales at 60-person company — NO sales_leader",
    expect: "All 3 are AEs. Director at 60 ppl = ae, NOT sales_leader (under 75, no AEs below them).",
    company: "ChannelCo", size: 60,
    employees: [
      { name: "Alex Chan", title: "Channel Account Executive" },
      { name: "Beth Part", title: "Strategic Partner Manager" },
      { name: "Carl Dir", title: "Director of Channel Sales" },
    ],
    jobs: [],
  },

  // --- EMPTY employees list ---
  {
    name: "9. LeadMagic returned zero employees",
    expect: "Graceful handling. Summary = 'No identifiable sales team on LinkedIn.'",
    company: "GhostCo", size: 18,
    employees: [],
    jobs: [],
  },

  // --- MIXED SIGNALS: AE title + CS title on same person ---
  {
    name: "10. Combo titles — 'Account Executive & Customer Success'",
    expect: "Should count as AE (sales side wins).",
    company: "HybridCo", size: 12,
    employees: [
      { name: "Dual Role RepB", title: "Account Executive & Customer Success Lead" },
      { name: "founder sue", title: "CEO" },
    ],
    jobs: [],
  },

  // --- Sales-adjacent roles that are NOT sellers ---
  {
    name: "11. Sales Engineer + RevOps + Enablement — none are sellers",
    expect: "Zero sellers. These are all support roles.",
    company: "SupportHeavy", size: 80,
    employees: [
      { name: "SE One", title: "Sales Engineer" },
      { name: "SE Two", title: "Solutions Consultant" },
      { name: "RO One", title: "Revenue Operations Manager" },
      { name: "EN One", title: "Sales Enablement Lead" },
      { name: "PS One", title: "Pre-Sales Solutions Architect" },
    ],
    jobs: [],
  },

  // --- VictoryXR exact data (the original failing case) ---
  {
    name: "12. VictoryXR real data — Directors are AEs at 32-person company",
    expect: "Erica=ae, Steve=founder_seller maybe. NOT leadership.",
    company: "VictoryXR", size: 32,
    employees: [
      { name: "steve grubbs", title: "CEO & Co-founder" },
      { name: "erica everett", title: "Director of K-12 Sales" },
      { name: "john king", title: "Director of all projects in the higher education space" },
      { name: "kathleen ouellette", title: "Director of Customer Success and Account Management" },
      { name: "tyler turner", title: "Director of Digital Media & Marketing" },
      { name: "david blinn", title: "General Manager" },
      { name: "melissa brent", title: "Director of Education" },
    ],
    jobs: [],
  },

  // --- Skill Struck exact data ---
  {
    name: "13. Skill Struck real data — 3 sellers at 53 ppl, NOT founder-led",
    expect: "Alex=ae, Joshua=ae, Talon=ae. Parker (CEO) should NOT be seller at 53 ppl.",
    company: "Skill Struck", size: 53,
    employees: [
      { name: "alex thorson", title: "National Director of Sales" },
      { name: "joshua burt", title: "Account Executive" },
      { name: "talon hatch", title: "Regional Sales Director" },
      { name: "parker gentry", title: "Founder and CEO" },
    ],
    jobs: [],
  },

  // --- Real hierarchy where sales_leader IS correct ---
  {
    name: "14. Actual sales_leader — VP Sales at 150-person co with 3 AEs below",
    expect: "VP = sales_leader, 3 AEs, 0 SDRs.",
    company: "RealHierarchy", size: 150,
    employees: [
      { name: "VP Jane", title: "VP of Sales" },
      { name: "Dir Bob", title: "Director of Sales" },
      { name: "AE Alice", title: "Account Executive" },
      { name: "AE Tom", title: "Senior Account Executive" },
      { name: "AE Sara", title: "Account Executive" },
    ],
    jobs: [{ title: "SDR - K12 Education" }],
  },
];

for (const t of tests) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${t.name}`);
  console.log(`EXPECT: ${t.expect}`);
  console.log(`${"=".repeat(60)}`);

  try {
    const result = await classify(t.employees, t.jobs, t.company, t.size);
    console.log(`sellers: ${result.sellers.map((s: any) => `${s.name} (${s.role})`).join(", ") || "none"}`);
    console.log(`ae=${result.ae_count} sdr=${result.sdr_count} leadership=${result.has_sales_leadership} founder=${result.founder_selling}`);
    console.log(`hiring: sdr=${result.hiring_sdr} ae=${result.hiring_ae} sales=${result.hiring_sales}`);
    console.log(`summary: ${result.summary}`);
  } catch (err: any) {
    console.log(`ERROR: ${err.message}`);
  }
}
