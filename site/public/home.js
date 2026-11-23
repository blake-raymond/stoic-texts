(function () {
  var oc = window.oldCounsel;
  var v = oc.variant;
  var V = {
    a: {
      eyebrow: "Talk to the Stoics",
      h1: "New trouble.\nOld counsel.",
      sub: "Tell it what's wrong. It answers the way Epictetus, Seneca, Musonius Rufus and Marcus Aurelius reasoned. In plain words. No quotes."
    },
    b: {
      eyebrow: "Talk to the Stoics",
      h1: "Stuck on a hard choice?",
      sub: "Talk it through with four Stoics. Epictetus, Seneca, Musonius Rufus and Marcus Aurelius, in one voice. Plain words. No quotes."
    },
    c: {
      eyebrow: "Old Counsel",
      h1: "Not another\nStoic quote.",
      sub: "Tell it what's wrong. It answers like the Stoics thought, in plain modern English. Built on Epictetus, Seneca, Musonius Rufus and Marcus Aurelius."
    }
  };
  ["eyebrow", "h1", "sub"].forEach(function (key) {
    var el = document.querySelector('[data-slot="' + key + '"]');
    if (el) el.textContent = V[v][key];
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

  var moreButton = document.getElementById("read-full");
  var more = document.querySelector(".reply-more");
  if (moreButton && more) {
    moreButton.addEventListener("click", function () {
      var expand = more.hasAttribute("hidden");
      if (expand) more.removeAttribute("hidden");
      else more.setAttribute("hidden", "");
      moreButton.setAttribute("aria-expanded", expand ? "true" : "false");
      moreButton.textContent = expand ? "Show less" : "Read the full reply";
    });
  }

  document.querySelectorAll("[data-cta]").forEach(function (button) {
    button.addEventListener("click", function () {
      oc.track("cta_click", { cta: button.getAttribute("data-cta") });
    });
  });

  fetch("/api/offer", { credentials: "same-origin", cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (offer) {
      if (!offer || offer.ok !== true) return;
      if (offer.portal) {
        document.querySelectorAll("[data-cancel]").forEach(function (el) {
          el.hidden = false;
        });
      }
      var remaining = offer.founding && offer.founding.remaining;
      if (typeof remaining !== "number") return;
      var label = remaining + (remaining === 1 ? " spot left" : " spots left");
      document.querySelectorAll("[data-founding]").forEach(function (el) {
        el.hidden = false;
      });
      document.querySelectorAll("[data-spots]").forEach(function (el) {
        el.textContent = label;
      });
    })
    .catch(function () {});
})();
