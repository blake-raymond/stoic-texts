(function () {
  var OFFER = "subscription";
  var VARIANTS = { a: 1, b: 1, c: 1 };
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

  function currentVariant() {
    var params = new URLSearchParams(location.search);
    var fromQuery = params.get("v");
    var stored = null;
    try { stored = localStorage.getItem("oc_v"); } catch (e) {}
    var v = (fromQuery && VARIANTS[fromQuery]) ? fromQuery : stored;
    if (!v || !VARIANTS[v]) v = "a";
    try {
      if (fromQuery && VARIANTS[fromQuery]) localStorage.setItem("oc_v", v);
    } catch (e) {}
    return v;
  }

  function readUtm() {
    var params = new URLSearchParams(location.search);
    var utm = {};
    try {
      var saved = JSON.parse(sessionStorage.getItem("oc_utm") || "{}");
      if (saved && typeof saved === "object") utm = saved;
    } catch (e) {}
    var changed = false;
    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) { utm[key] = value; changed = true; }
    });
    if (changed) {
      try { sessionStorage.setItem("oc_utm", JSON.stringify(utm)); } catch (e) {}
    }
    return utm;
  }

  var variant = currentVariant();
  var utm = readUtm();

  function track(name, props) {
    var event = Object.assign({ event: name, variant: variant, offer: OFFER, ts: Date.now() }, utm, props || {});
    var body = JSON.stringify(event);
    try {
      if (navigator.sendBeacon) {
        var sent = navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }));
        if (sent) return;
      }
    } catch (e) {}
    fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body,
      keepalive: true,
      credentials: "omit",
      cache: "no-store"
    });
  }

  window.oldCounsel = { variant: variant, track: track };
})();
