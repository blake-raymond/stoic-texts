(function () {
  var oc = window.oldCounsel;
  // Headline variants b and c are paused. track.js still records a stored variant.
  var copy = {
    eyebrow: "Talk to the Stoics",
    h1: "New trouble.\nOld counsel.",
    sub: "Tell it what's wrong. It helps you think clearly about a hard choice, a hard person or a hard day. In the voice of Epictetus, Seneca, Musonius Rufus and Marcus Aurelius. Plain words."
  };
  ["eyebrow", "h1", "sub"].forEach(function (key) {
    var el = document.querySelector('[data-slot="' + key + '"]');
    if (el) el.textContent = copy[key];
  });

  var params = new URLSearchParams(location.search);
  var utm = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (key) {
    if (params.get(key)) utm[key] = params.get(key);
  });
  oc.track("page_view", Object.assign({ referrer: document.referrer || "" }, utm));

  var marks = [25, 50, 75, 100];
  var hit = {};
  addEventListener("scroll", function () {
    var h = document.documentElement;
    var pct = Math.round((h.scrollTop + innerHeight) / h.scrollHeight * 100);
    marks.forEach(function (mark) {
      if (pct >= mark && !hit[mark]) {
        hit[mark] = 1;
        oc.track("scroll_depth", { depth: mark });
      }
    });
  }, { passive: true });

  var example = document.querySelector(".example");
  if ("IntersectionObserver" in window && example) {
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        oc.track("example_view");
        observer.disconnect();
      }
    }, { threshold: 0.5 });
    observer.observe(example);
  }

  document.querySelectorAll("[data-link]").forEach(function (link) {
    link.addEventListener("click", function () {
      oc.track("link_click", { link: link.getAttribute("data-link") });
    });
  });
  document.querySelectorAll("details").forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (item.open) oc.track("faq_open", { q: item.querySelector("summary").textContent });
    });
  });

  document.querySelectorAll("[data-cta]").forEach(function (button) {
    button.addEventListener("click", function () {
      oc.track("cta_click", { cta: button.getAttribute("data-cta") });
    });
  });

  var tabs = document.querySelector(".example-tabs");
  if (tabs) {
    var tabButtons = tabs.querySelectorAll("[role='tab']");
    function showExample(id) {
      tabButtons.forEach(function (tab) {
        var on = tab.getAttribute("aria-controls") === id;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));
        if (panel) {
          if (on) panel.removeAttribute("hidden");
          else panel.setAttribute("hidden", "");
        }
      });
    }
    tabButtons.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        showExample(tab.getAttribute("aria-controls"));
      });
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight") next = (index + 1) % tabButtons.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabButtons.length) % tabButtons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabButtons.length - 1;
        else return;
        event.preventDefault();
        var target = tabButtons[next];
        target.focus();
        showExample(target.getAttribute("aria-controls"));
      });
    });
  }

  var root = document.querySelector(".pricing");
  var openedAt = Date.now();
  function hideFounding() {
    document.querySelectorAll("[data-founding]").forEach(function (el) {
      el.hidden = true;
    });
  }
  function showPricingNote(message) {
    if (!root) return;
    var el = root.querySelector("[data-pricing-note]");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }
  if (root) {
    var billingButtons = root.querySelectorAll("[data-billing]");
    var price = root.querySelector("[data-pro-price]");
    var note = root.querySelector("[data-pro-note]");
    var proCta = root.querySelector("[data-pro-cta]");
    var periods = {
      yearly: { amount: "15", note: "Billed $180 yearly", plan: "yearly" },
      monthly: { amount: "19", note: "Billed monthly", plan: "monthly" }
    };
    function setPeriod(period) {
      var chosen = periods[period] || periods.yearly;
      if (price) price.textContent = chosen.amount;
      if (note) note.textContent = chosen.note;
      if (proCta) proCta.setAttribute("data-plan", chosen.plan);
      root.setAttribute("data-period", chosen.plan);
      billingButtons.forEach(function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-billing") === chosen.plan ? "true" : "false");
      });
    }
    billingButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setPeriod(button.getAttribute("data-billing"));
      });
    });

    root.querySelectorAll("[data-plan]").forEach(function (button) {
      button.addEventListener("click", function () {
        var plan = button.getAttribute("data-plan");
        if (!plan || button.disabled) return;
        button.disabled = true;
        oc.track("checkout_click", {
          cta: "offer",
          ms_open: Math.max(0, Date.now() - openedAt)
        });
        try {
          sessionStorage.setItem("oc_checkout", JSON.stringify({ cta: "offer" }));
        } catch (e) {}
        fetch("/api/checkout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan: plan })
        })
          .then(function (response) {
            return response.json().then(function (body) {
              return body || {};
            }, function () {
              return {};
            });
          })
          .then(function (body) {
            if (typeof body.url === "string" && body.url) {
              location.assign(body.url);
              return;
            }
            if (body.code === "founding_full") {
              hideFounding();
              showPricingNote("That offer is full.");
            } else {
              showPricingNote("Checkout isn't available right now. Email help@oldcounsel.com.");
            }
            button.disabled = false;
          })
          .catch(function () {
            showPricingNote("Checkout isn't available right now. Email help@oldcounsel.com.");
            button.disabled = false;
          });
      });
    });
  }

  fetch("/api/offer", { credentials: "same-origin", cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (offer) {
      if (!offer || offer.ok !== true) {
        hideFounding();
        return;
      }
      if (offer.portal) {
        document.querySelectorAll("[data-cancel]").forEach(function (el) {
          el.hidden = false;
        });
      }
      var remaining = offer.founding && offer.founding.remaining;
      if (typeof remaining !== "number" || remaining <= 0) {
        hideFounding();
        return;
      }
      var label = remaining + (remaining === 1 ? " spot left" : " spots left");
      document.querySelectorAll("[data-spots]").forEach(function (el) {
        el.textContent = label;
      });
      document.querySelectorAll("[data-founding]").forEach(function (el) {
        el.hidden = false;
      });
    })
    .catch(function () {
      hideFounding();
    });
})();
