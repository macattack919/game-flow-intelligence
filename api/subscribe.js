export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: "Supabase configuration missing" });
    }

    const subscription = req.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: "Invalid push subscription" });
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        enabled: true
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Supabase subscription save failed:", response.status, detail);
      return res.status(500).json({ error: "Unable to save notification subscription", detail });
    }

    return res.status(200).json({ success: true, message: "GFI push subscription saved" });
  } catch (error) {
    console.error("Subscription handler failed:", error);
    return res.status(500).json({ error: "Subscription handler failed", detail: error.message });
  }
}
