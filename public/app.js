(function () {
  "use strict";
  var doc = document;
  doc.documentElement.classList.add("js");

  // ---------------------------------------------------------------- progress bar
  var bar = doc.getElementById("progress"), barTimer = null;
  function progressStart() {
    if (!bar) return;
    var w = 8; bar.classList.add("on"); bar.style.width = w + "%";
    clearInterval(barTimer);
    barTimer = setInterval(function () { w += (90 - w) * 0.08; bar.style.width = w + "%"; }, 200);
  }
  function progressDone() {
    if (!bar) return;
    clearInterval(barTimer); bar.style.width = "100%";
    setTimeout(function () { bar.classList.remove("on"); bar.style.width = "0"; }, 250);
  }

  // ---------------------------------------------------------------- toasts
  var toasts = doc.getElementById("toasts");
  var ICON = { ok: "✓", err: "!", info: "i" };
  function toast(type, text, ms) {
    if (!toasts) return;
    var t = doc.createElement("div");
    t.className = "toast " + type; t.setAttribute("role", type === "err" ? "alert" : "status");
    var ic = doc.createElement("span"); ic.className = "ic"; ic.textContent = ICON[type] || "i";
    var tx = doc.createElement("span"); tx.textContent = text;
    t.appendChild(ic); t.appendChild(tx); toasts.appendChild(t);
    var close = function () { if (t.classList.contains("out")) return; t.classList.add("out"); setTimeout(function () { t.remove(); }, 300); };
    t.addEventListener("click", close);
    setTimeout(close, ms || (type === "err" ? 7000 : 3500));
  }
  window.appToast = toast;

  // Server flash messages → toasts, then tidy the URL so a refresh doesn't repeat them.
  doc.querySelectorAll("[data-toast]").forEach(function (el) { toast(el.getAttribute("data-toast"), el.textContent.trim()); });
  try {
    var u = new URL(location.href), dirty = false;
    ["ok", "err", "msg"].forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); dirty = true; } });
    if (dirty) history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  } catch (e) {}

  // ---------------------------------------------------------------- confirm sheet (replaces window.confirm)
  function confirmSheet(opts) {
    return new Promise(function (resolve) {
      var back = doc.createElement("div"); back.className = "sheet-backdrop";
      back.innerHTML = '<div class="sheet" role="alertdialog" aria-modal="true"><div class="body"><h4></h4><p></p></div>' +
        '<div class="actions"><button type="button" data-no>Cancel</button><button type="button" data-yes></button></div></div>';
      back.querySelector("h4").textContent = opts.title || "Are you sure?";
      var p = back.querySelector("p"); if (opts.message) p.textContent = opts.message; else p.remove();
      var yes = back.querySelector("[data-yes]"); yes.textContent = opts.ok || "Confirm";
      if (opts.destructive) yes.classList.add("destructive");
      doc.body.appendChild(back);
      var prev = doc.activeElement; yes.focus();
      function done(v) {
        doc.removeEventListener("keydown", onKey);
        back.classList.add("out"); setTimeout(function () { back.remove(); if (prev && prev.focus) prev.focus(); }, 200);
        resolve(v);
      }
      function onKey(e) { if (e.key === "Escape") done(false); if (e.key === "Enter") { e.preventDefault(); done(true); } }
      doc.addEventListener("keydown", onKey);
      back.addEventListener("click", function (e) { if (e.target === back) done(false); });
      back.querySelector("[data-no]").addEventListener("click", function () { done(false); });
      yes.addEventListener("click", function () { done(true); });
    });
  }
  window.appConfirm = confirmSheet;

  // ---------------------------------------------------------------- forms: confirm + loading state
  function setBusy(form, btn) {
    form.dataset.submitting = "1";
    if (btn) {
      btn.classList.add("loading");
      setTimeout(function () { btn.disabled = true; }, 0); // after the browser has read the form
      var note = form.getAttribute("data-busy");
      if (note && !form.querySelector(".busy-note")) {
        var n = doc.createElement("span"); n.className = "busy-note"; n.textContent = note; btn.insertAdjacentElement("afterend", n);
      }
    }
    progressStart();
  }
  function resetBusy() {
    doc.querySelectorAll("form[data-submitting]").forEach(function (f) { delete f.dataset.submitting; delete f.dataset.confirmed; });
    doc.querySelectorAll("button.loading").forEach(function (b) { b.classList.remove("loading"); b.disabled = false; });
    doc.querySelectorAll(".busy-note").forEach(function (n) { n.remove(); });
    progressDone();
  }
  doc.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.dataset.submitting) { e.preventDefault(); return; } // no double submits
    var btn = e.submitter || form.querySelector("button:not([type=button])");
    var q = form.getAttribute("data-confirm");
    if (q && !form.dataset.confirmed) {
      e.preventDefault();
      confirmSheet({
        title: q,
        message: form.getAttribute("data-confirm-detail") || "",
        ok: form.getAttribute("data-confirm-ok") || (btn ? btn.textContent.trim() : "Confirm"),
        destructive: !!(btn && btn.classList.contains("danger")) || form.hasAttribute("data-destructive"),
      }).then(function (yes) {
        if (!yes) return;
        form.dataset.confirmed = "1";
        setBusy(form, btn);
        HTMLFormElement.prototype.submit.call(form);
      });
      return;
    }
    setBusy(form, btn);
  });
  // Coming back with the Back button restores the old page; clear any spinners.
  window.addEventListener("pageshow", function (e) { if (e.persisted) resetBusy(); });

  // Loading bar for normal link navigation.
  doc.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#" || a.origin !== location.origin) return;
    progressStart();
  });
  window.addEventListener("load", progressDone);

  // ---------------------------------------------------------------- copy to clipboard
  function fallbackCopy(text) {
    var ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    doc.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function selectContents(el) {
    var r = doc.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  doc.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (!b) return;
    copyText(b.getAttribute("data-copy")).then(function (ok) {
      if (ok) {
        if (b.tagName === "BUTTON") { var t = b.textContent; b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = t; }, 1500); }
        else { b.classList.add("copied"); setTimeout(function () { b.classList.remove("copied"); }, 1500); }
        toast("ok", "Copied to clipboard", 1800);
      } else {
        var sel = b.getAttribute("data-copy-select") ? doc.getElementById(b.getAttribute("data-copy-select")) : (b.tagName === "BUTTON" ? null : b);
        if (sel) selectContents(sel);
        toast("info", "Copy is blocked here. The text is selected: press ⌘C (Mac) or Ctrl+C.", 5000);
      }
    });
  });

  // ---------------------------------------------------------------- dashboard polish
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Progress ring fills in.
  doc.querySelectorAll(".ring .bar[data-offset]").forEach(function (c) {
    requestAnimationFrame(function () { requestAnimationFrame(function () { c.style.strokeDashoffset = c.getAttribute("data-offset"); }); });
  });
  // Numbers count up.
  doc.querySelectorAll("[data-count]").forEach(function (el) {
    var end = parseInt(el.getAttribute("data-count"), 10) || 0;
    if (reduce || end === 0) return;
    var start = null, dur = Math.min(1200, 400 + end * 40);
    el.textContent = "0";
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(end * e));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
  // Whole table row is clickable.
  doc.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-href]");
    if (!tr || e.target.closest("a,button,input")) return;
    progressStart(); location.href = tr.getAttribute("data-href");
  });
  // Show / hide for password and API-key fields.
  var EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  doc.querySelectorAll('input[type="password"]').forEach(function (inp) {
    var wrap = doc.createElement("div"); wrap.className = "reveal";
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    var b = doc.createElement("button"); b.type = "button"; b.innerHTML = EYE; b.setAttribute("aria-label", "Show"); b.title = "Show";
    b.addEventListener("click", function () {
      var show = inp.type === "password"; inp.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_OFF : EYE; b.setAttribute("aria-label", show ? "Hide" : "Show"); b.title = show ? "Hide" : "Show"; inp.focus();
    });
    wrap.appendChild(b);
  });
  // A little celebration when a channel goes live.
  function confetti() {
    if (reduce) return;
    var box = doc.createElement("div"); box.className = "confetti";
    var colors = ["#0a84ff", "#30d158", "#ff9f0a", "#ff375f", "#bf5af2", "#64d2ff"];
    for (var i = 0; i < 70; i++) {
      var c = doc.createElement("i");
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = colors[i % colors.length];
      c.style.setProperty("--x", (Math.random() * 30 - 15) + "vw");
      c.style.setProperty("--r", (Math.random() * 900 - 450) + "deg");
      c.style.setProperty("--d", (1.8 + Math.random() * 1.6) + "s");
      c.style.animationDelay = Math.random() * 0.25 + "s";
      box.appendChild(c);
    }
    doc.body.appendChild(box); setTimeout(function () { box.remove(); }, 4000);
  }
  window.appConfetti = confetti;
  doc.querySelectorAll('[data-toast="ok"]').forEach(function (el) { if (/\bis live\b/i.test(el.textContent)) setTimeout(confetti, 250); });

  // ---------------------------------------------------------------- test chat
  var chat = doc.getElementById("chat");
  if (!chat) return;
  var msgs = chat.querySelector(".msgs"), form = chat.querySelector("form"), input = form.querySelector("input"), sendBtn = form.querySelector("button");
  var csrf = chat.getAttribute("data-csrf"), waiting = false;
  function add(cls, text) {
    var d = doc.createElement("div"); d.className = "m " + cls; d.textContent = text; msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function typing() {
    var d = doc.createElement("div"); d.className = "m b"; d.innerHTML = '<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>';
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function send(text) {
    if (!text || waiting) return;
    waiting = true; add("u", text); input.value = ""; sendBtn.classList.add("loading");
    var t = typing();
    fetch(chat.getAttribute("data-endpoint"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ text: text }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { t.remove(); add("b", j.reply || j.error || "No reply"); if (j.error) toast("err", j.error); })
      .catch(function () { t.remove(); add("b", "Network error. Try again."); toast("err", "Network error. Check your connection."); })
      .finally(function () { waiting = false; sendBtn.classList.remove("loading"); input.focus(); });
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); e.stopPropagation(); send(input.value.trim()); }, true);
  doc.querySelectorAll("[data-suggest]").forEach(function (b) { b.addEventListener("click", function () { send(b.getAttribute("data-suggest")); }); });
  var reset = doc.querySelector("[data-chat-reset]");
  if (reset) reset.addEventListener("click", function () {
    reset.classList.add("loading");
    fetch(chat.getAttribute("data-reset"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}" })
      .then(function () { msgs.innerHTML = ""; add("b", "Started a new conversation."); toast("ok", "Conversation reset"); })
      .finally(function () { reset.classList.remove("loading"); });
  });
  add("b", "Hi! I'm your booking assistant. Try a suggestion above, or type anything.");
})();
