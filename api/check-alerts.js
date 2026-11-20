import webpush from "web-push";

const TRIPLE_DIPPER_TARGET = 999; // Reserved value in the existing push_alert_history table.
const ALLOWED_ORIGINS = new Set(["https://game-flow-intelligence.vercel.app"]);

function isNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function evaluateTripleDipper(game) {
  if (!game || game.state !== "in") return false;
  const period = Number(game.period);
  const regulationPeriods = Number(game.regulationPeriods ?? 2);
  const elapsed = Number(game.elapsedMinutes);
  const remaining = Number(game.remainingMinutes);
  const home = Number(game.homeScore);
  const away = Number(game.awayScore);
  const liveLine = Number(game.liveLine);

  if (period !== 2 || period > regulationPeriods) return false;
  if (![elapsed, remaining, home, away, liveLine].every(Number.isFinite)) return false;
  if (elapsed < 20 || elapsed > 32 || remaining <= 0 || liveLine < 50 || liveLine > 250) return false;
  if (Math.abs(home - away) <= 8) return false;

  const currentTotal = home + away;
  const neededPpm = (liveLine - currentTotal) / remaining;
  const actualPpm = currentTotal / elapsed;
  const gapPpm = neededPpm - actualPpm;

  return neededPpm >= 4.7 && gapPpm >= 1.3;
}

async function supabaseRequest(url, key, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "Requests must come from the GFI website" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;

    if (!supabaseUrl || !supabaseKey || !publicKey || !privateKey || !subject) {
      return res.status(500).json({ error: "Push server configuration missing" });
    }

    const games = Array.isArray(req.body?.games) ? req.body.games.slice(0, 80) : [];
    const qualifying = games.filter(evaluateTripleDipper);
    if (!qualifying.length) return res.status(200).json({ success: true, alertsSent: 0, message: "No Triple Dipper signals" });

    webpush.setVapidDetails(subject, publicKey, privateKey);

    const [historyResponse, subscriberResponse] = await Promise.all([
      supabaseRequest(`${supabaseUrl}/rest/v1/push_alert_history?select=game_id,target&target=eq.${TRIPLE_DIPPER_TARGET}`, supabaseKey),
      supabaseRequest(`${supabaseUrl}/rest/v1/push_subscriptions?enabled=eq.true&select=endpoint,p256dh,auth`, supabaseKey)
    ]);
    if (!historyResponse.ok) throw new Error("Unable to retrieve push alert history: " + await historyResponse.text());
    if (!subscriberResponse.ok) throw new Error("Unable to retrieve push subscribers: " + await subscriberResponse.text());

    const history = await historyResponse.json();
    const alreadySent = new Set(history.map(row => String(row.game_id)));
    const subscribers = await subscriberResponse.json();
    if (!subscribers.length) return res.status(200).json({ success: true, alertsSent: 0, message: "No enabled GFI push subscribers" });

    let alertsSent = 0;
    const results = [];
    for (const game of qualifying) {
      const eventId = String(game.eventId || "");
      if (!/^\d{1,20}$/.test(eventId) || alreadySent.has(eventId)) continue;

      const home = Number(game.homeScore);
      const away = Number(game.awayScore);
      const currentTotal = home + away;
      const elapsed = Number(game.elapsedMinutes);
      const remaining = Number(game.remainingMinutes);
      const neededPpm = (Number(game.liveLine) - currentTotal) / remaining;
      const actualPpm = currentTotal / elapsed;
      const gapPpm = neededPpm - actualPpm;
      const score = `${game.awayName || "Away"} ${away} · ${game.homeName || "Home"} ${home}`;
      const body = `${score} | ${game.clock || "Live"} | Live total ${Number(game.liveLine).toFixed(1)} | Needed ${neededPpm.toFixed(2)} PPM · current pace ${actualPpm.toFixed(2)} PPM · gap ${gapPpm.toFixed(2)}`;
      const payload = JSON.stringify({
        title: "GFI · TRIPLE DIPPER UNDER",
        body,
        tag: `gfi-triple-dipper-${eventId}`,
        url: "/"
      });

      let deliveries = 0;
      for (const device of subscribers) {
        try {
          await webpush.sendNotification({
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth }
          }, payload);
          deliveries++;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await supabaseRequest(
              `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(device.endpoint)}`,
              supabaseKey,
              { method: "PATCH", body: JSON.stringify({ enabled: false }) }
            );
          } else {
            console.warn("Push delivery failed:", error.message);
          }
        }
      }

      if (deliveries > 0) {
        const saveResponse = await supabaseRequest(
          `${supabaseUrl}/rest/v1/push_alert_history`,
          supabaseKey,
          {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
            body: JSON.stringify([{ game_id: eventId, target: TRIPLE_DIPPER_TARGET }])
          }
        );
        if (!saveResponse.ok) throw new Error("Unable to save push alert history: " + await saveResponse.text());
        alreadySent.add(eventId);
        alertsSent++;
        results.push({ eventId, game: game.name || score, deliveries });
      }
    }

    return res.status(200).json({
      success: true, checkedGames: qualifying.length, alertsSent, results
    });
  } catch (error) {
    console.error("GFI push alert check failed:", error);
    return res.status(500).json({ error: "Push alert check failed", detail: error.message });
  }
}
