// Spot-test: run 8 "EdTech Services" companies through a tighter SLED-only prompt
// Zero side effects — no Supabase writes, just Claude API calls + console output.
// Usage: npx tsx scripts/test-classifier-v2.mts

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are a B2B sub-market classifier for Acme GTM, a B2B company that sells to companies in the SLED market.

Given a company, classify it into ONE of these categories:

- "K12" — Company sells products or services TO K-12 school districts, schools, or educators. The delivery model (SaaS, services, hardware, curriculum) does not matter. Classify by BUYER.
- "Higher Ed" — Company sells products or services TO universities, community colleges, or post-secondary institutions.
- "Government" — Company sells products or services TO federal, state, or local government agencies.
- "Not SLED" — Company does NOT primarily sell to K-12, Higher Ed, or Government buyers. This includes: institutions themselves (universities, school districts, government agencies are BUYERS not sellers), corporate L&D, consumer/B2C, general B2B SaaS, consulting firms selling to consumers/families (e.g. college admissions consulting for families is B2C, not Higher Ed).

CRITICAL: Classify by who the company SELLS TO, not what they are. A tutoring company that contracts with K-12 districts is "K12". An admissions consulting firm that sells to individual families is "Not SLED". A company making LMS software for universities is "Higher Ed".`;

const companies = [
  // --- Currently K12 EdTech SaaS (should stay K12) ---
  { name: "Branching Minds", domain: "branchingminds.com", desc: "Unites learning sciences and technology to empower teachers to identify students' cognitive and behavioral challenges and strengths; curates learning supports.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "TCI", domain: "teachtci.com", desc: "Provides K-12 educators with inquiry-based science and social studies curriculum solutions designed to engage students and drive learning.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "LINQ", domain: "linq.com", desc: "Revolutionizes K-12 operations with cloud-based software. Integrates finance, HR, nutrition, and payments. Partners with 30% of U.S. school districts.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "MasteryPrep", domain: "masteryprep.com", desc: "Provides districts and schools with readiness programs and solutions that help improve student achievement on required assessments.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "Huddle Up", domain: "huddleupcare.com", desc: "Partners with K-12 districts to deliver special education services across speech therapy, OT, mental health, and school psychology.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "Ellevation Education", domain: "ellevationeducation.com", desc: "Web-based software platform for EL educators and English learners. Supports 1,700 partner districts and 2.5 million students.", industry: "Education Management", old: "K12 EdTech SaaS" },
  { name: "Schola", domain: "schola.com", desc: "Trusted partner for PK-12 schools and families during enrollment journey. Empowers schools with outreach and EdTech tools to attract, enroll, and retain students.", industry: "Education Management", old: "K12 EdTech SaaS" },
  // --- Currently Higher Ed (should stay Higher Ed) ---
  { name: "Engage2Serve", domain: "engage2serve.com", desc: "Global provider of student lifecycle solutions for higher education. Optimizes how institutions connect with and support diverse student populations.", industry: "Higher Education", old: "Higher Ed" },
  { name: "CollegeVine", domain: "collegevine.com", desc: "Deploys safe AI Agents to drive real outcomes across campus for higher education. Believes AI will dramatically increase efficiency for higher ed.", industry: "Computer Software", old: "Higher Ed" },
  { name: "EduNav", domain: "edunav.com", desc: "Academic planning, degree discovery, and academic mobility solutions which help colleges and universities to graduate more students.", industry: "Education Management", old: "Higher Ed" },
  { name: "Yellowdig", domain: "yellowdig.co", desc: "Platform fostering meaningful interactions between students and educators. Over 200 institutions leveraging solutions for social learning and gamification.", industry: "E-learning", old: "Higher Ed" },
  { name: "Acadeum", domain: "acadeum.com", desc: "Helps colleges and universities expand academic portfolios. More than 460 higher education institutions use the Acadeum network.", industry: "E-learning", old: "Higher Ed" },
];

async function main() {
  console.log("Regression test: does the new prompt break existing K12 / Higher Ed classifications?\n");
  console.log("Company".padEnd(28) + "OLD".padEnd(18) + "NEW".padEnd(12) + "MATCH?   Reason");
  console.log("-".repeat(120));

  let pass = 0, fail = 0;
  for (const co of companies) {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: PROMPT,
      tools: [{
        name: "classify",
        description: "Classify company",
        input_schema: {
          type: "object",
          properties: {
            sub_market: { type: "string", enum: ["K12", "Higher Ed", "Government", "Not SLED"] },
            reason: { type: "string" },
          },
          required: ["sub_market", "reason"],
        },
      }],
      tool_choice: { type: "tool", name: "classify" },
      messages: [{ role: "user", content: `Company: ${co.name}\nDomain: ${co.domain}\nIndustry: ${co.industry}\nDescription: ${co.desc}` }],
    });

    const tool = resp.content.find(c => c.type === "tool_use");
    const r = tool?.input as any;
    // Map old values to new for comparison
    const expectedNew = co.old === "K12 EdTech SaaS" ? "K12" : co.old === "Higher Ed" ? "Higher Ed" : co.old;
    const match = r.sub_market === expectedNew;
    if (match) pass++; else fail++;
    const flag = match ? "  OK  " : "BREAK!";
    console.log(`${co.name.padEnd(28)}${co.old.padEnd(18)}${r.sub_market.padEnd(12)}${flag}   ${r.reason.slice(0, 80)}`);
  }
  console.log(`\n${pass}/${pass+fail} matched. ${fail} regressions.`)
}

main().catch(console.error);
