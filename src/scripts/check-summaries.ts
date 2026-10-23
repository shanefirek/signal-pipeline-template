import { supabase } from '../lib/supabase.js';

async function main() {
  // Check specific contacts that were re-run with v2 summaries
  const emails = ['pramod@exampleco', 'user@example.com', 'user@example.com'];
  const { data } = await supabase
    .from('contacts')
    .select('email, domain, tier, icp_score, lead_summary')
    .in('email', emails);

  for (const c of data || []) {
    console.log('===');
    console.log(`${c.email} | ${c.domain} | ${c.tier} | ICP: ${c.icp_score}`);
    console.log(c.lead_summary);
    console.log('');
  }
}
main();
