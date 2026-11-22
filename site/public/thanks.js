(function () {
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
