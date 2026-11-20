self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: "GAME FLOW INTELLIGENCE", body: event.data ? event.data.text() : "New live-game alert" };
  }

  event.waitUntil(self.registration.showNotification(
    data.title || "GAME FLOW INTELLIGENCE",
    {
      body: data.body || "A live NCAA game met the Triple Dipper conditions.",
      tag: data.tag || "gfi-triple-dipper-alert",
      renotify: false,
      requireInteraction: true,
      data: { url: data.url || "/" }
    }
  ));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if ("focus" in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
