export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    const endpoint = req.body?.endpoint;
    if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase configuration missing" });
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      return res.status(400).json({ error: "Valid push endpoint is required" });
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
      {
        method: "PATCH",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ enabled: false })
      }
    );
    if (!response.ok) return res.status(500).json({ error: "Unable to disable push subscription", detail: await response.text() });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Unsubscribe handler failed", detail: error.message });
  }
}
