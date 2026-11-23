(function () {
  var ready = document.body.getAttribute("data-refund") === "yes";
  var open = document.getElementById("ready");
  var closed = document.getElementById("closed");
  if (ready && open && closed) {
    open.hidden = false;
    closed.hidden = true;
  }
  if (!ready || !open) return;

  var ask = document.getElementById("ask");
  var note = document.getElementById("ask-note");
  var confirmForm = document.getElementById("confirm");
  var done = document.getElementById("done");
  var fallback = "Email help@oldcounsel.com and you'll be refunded in full.";

  function show(node, text) {
    if (!node) return;
    node.hidden = false;
    node.textContent = text;
  }

  function post(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (response) {
      return response.json();
    });
  }

  if (ask) {
    ask.addEventListener("submit", function (event) {
      event.preventDefault();
      var button = ask.querySelector("button");
      if (button) button.disabled = true;
      post("/api/refund/request", { email: ask.email.value }).then(function (body) {
        show(note, (body && body.message) || fallback);
        if (body && body.ok && confirmForm) confirmForm.hidden = false;
        if (button) button.disabled = false;
      }).catch(function () {
        show(note, fallback);
        if (button) button.disabled = false;
      });
    });
  }

  if (confirmForm) {
    confirmForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var button = confirmForm.querySelector("button");
      if (button) button.disabled = true;
      post("/api/refund/confirm", {
        email: ask && ask.email ? ask.email.value : "",
        code: confirmForm.code.value,
      }).then(function (body) {
        show(done, (body && body.message) || fallback);
        if (body && body.done) {
          if (ask) ask.hidden = true;
          confirmForm.hidden = true;
          if (note) note.hidden = true;
        }
        if (button) button.disabled = false;
      }).catch(function () {
        show(done, fallback);
        if (button) button.disabled = false;
      });
    });
  }
})();
