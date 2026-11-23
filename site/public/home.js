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
  var lastCta = null;
  var opened = 0;
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

  var door = document.getElementById("door");
  var buy = document.getElementById("door-buy");
  function openDoor(id) {
    lastCta = id;
    opened = Date.now();
    buy.href = buy.getAttribute("data-base") + "?client_reference_id=" + encodeURIComponent(id + "_" + v);
    door.classList.add("open");
    door.setAttribute("aria-hidden", "false");
    oc.track("cta_click", { cta: id });
    oc.track("door_view", { cta: id });
    setTimeout(function () { buy.focus(); }, 50);
  }
  function closeDoor() {
    if (!door.classList.contains("open")) return;
    door.classList.remove("open");
    door.setAttribute("aria-hidden", "true");
    oc.track("door_close", { cta: lastCta, ms_open: Date.now() - opened });
  }
  document.querySelectorAll("[data-cta]").forEach(function (button) {
    button.addEventListener("click", function () {
      var id = button.getAttribute("data-cta");
      if (button.tagName === "A") {
        oc.track("cta_click", { cta: id });
        return;
      }
      openDoor(id);
    });
  });
  document.getElementById("door-x").addEventListener("click", closeDoor);
  door.addEventListener("click", function (event) { if (event.target === door) closeDoor(); });
  addEventListener("keydown", function (event) {
    if (event.key === "Escape" && door.classList.contains("open")) closeDoor();
  });
  buy.addEventListener("click", function () {
    try {
      sessionStorage.setItem("oc_checkout", JSON.stringify({ cta: lastCta, variant: v }));
    } catch (e) {}
    oc.track("checkout_click", { cta: lastCta, ms_open: Date.now() - opened });
  });
})();
