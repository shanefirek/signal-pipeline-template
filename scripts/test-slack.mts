import "dotenv/config";

const webhookUrl = process.env.SLACK_WEBHOOK_URL;

// Real data from exampleco
const testData = {
  text: "Hot MQL: Ilinka Lagman at exampleco",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*:fire: Hot MQL · Website Visitor  —  RepA*\n*Ilinka Lagman* — Director, People Operations @ *exampleco*\n:envelope: user@example.com  |  <https://www.linkedin.com/in/ilinkalagman|LinkedIn>"
      }
    },
    {
      type: "section", 
      text: {
        type: "mrkdwn",
        text: ":bar_chart: *Total 82*  |  ICP 57  |  Intent 25\n:globe_with_meridians: Website Visitor"
      }
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn", 
        text: ":office: K12 EdTech SaaS\n:busts_in_silhouette: 0 AEs · 1 SDR (Debbie Morton) · *hiring AEs*"
      }
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Why this matters:*\nexampleco is a K-12 staffing platform that connects schools with substitute teachers, selling into school districts and education administrators. Their sales org currently has one SDR and zero AEs, with an AE hire actively in progress. That gap is the opening — they're trying to scale outbound before their first AE is even in seat, which makes this a strong moment to talk about how ACME can bridge that coverage now and ramp pipeline so the incoming AE has something to work with from day one."
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in HubSpot" },
          url: "https://app.hubspot.com/contacts/244264386/contact/123456789",
          style: "primary"
        }
      ]
    }
  ]
};

async function main() {
  console.log("Sending REAL MQL alert (exampleco)...\n");
  
  const res = await fetch(webhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testData),
  });
  
  if (res.ok) {
    console.log("✓ Sent! Check Slack.");
  } else {
    console.log("Failed:", await res.text());
  }
}

main().catch(console.error);
