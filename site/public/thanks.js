(function () {
  var state = document.body.getAttribute("data-thanks");
  var granted = document.getElementById("granted");
  var unconfirmed = document.getElementById("unconfirmed");
  if (state === "granted" && granted) granted.hidden = false;
  else if (unconfirmed) unconfirmed.hidden = false;

  var kind = document.body.getAttribute("data-kind");
  var refund = document.getElementById("thanks-refund");
  if (refund && kind === "founding") refund.hidden = false;
  var cancel = document.getElementById("thanks-cancel");
  if (state === "granted" && cancel) {
    fetch("/api/offer", { credentials: "same-origin", cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (offer) {
        if (offer && offer.portal) cancel.hidden = false;
      })
      .catch(function () {});
    var portal = document.getElementById("portal");
    if (portal) {
      portal.addEventListener("click", function () {
        portal.disabled = true;
        fetch("/api/billing/portal", { method: "POST", credentials: "same-origin" })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.url) location.assign(body.url);
            else portal.disabled = false;
          })
          .catch(function () { portal.disabled = false; });
      });
    }
  }

  var params = new URLSearchParams(location.search);
  var sessionId = params.get("session_id") || "";
  var key = "oc_purchase_return:" + sessionId;
  var props = { session_id: sessionId };
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    var saved = sessionStorage.getItem("oc_checkout");
    if (saved) {
      var parsed = JSON.parse(saved);
      if (parsed && parsed.cta) props.cta = parsed.cta;
    }
  } catch (e) {}
  window.oldCounsel.track("purchase_return", props);
})();
