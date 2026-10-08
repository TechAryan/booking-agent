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

  // ---------------------------------------------------------------- appearance (light / dark / system)
  var ICONS = {};
  doc.querySelectorAll(".theme-pick [data-set-theme]").forEach(function (b) { ICONS[b.getAttribute("data-set-theme")] = b.querySelector("svg").outerHTML; });
  function setTheme(t) {
    var root = doc.documentElement;
    root.classList.add("theming");
    root.setAttribute("data-theme", t);
    setTimeout(function () { root.classList.remove("theming"); }, 400);
    doc.querySelectorAll("[data-set-theme]").forEach(function (b) { b.setAttribute("aria-checked", b.getAttribute("data-set-theme") === t ? "true" : "false"); });
    var tg = doc.querySelector("[data-theme-toggle]"); if (tg && ICONS[t]) tg.innerHTML = ICONS[t];
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var meta = doc.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", dark ? "#000000" : "#f5f5f7");
    fetch("/theme", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: t }) }).catch(function () {});
  }
  var pick = doc.querySelector(".theme-pick");
  if (pick) {
    var tgl = pick.querySelector("[data-theme-toggle]");
    tgl.addEventListener("click", function (e) { e.stopPropagation(); var open = pick.classList.toggle("open"); tgl.setAttribute("aria-expanded", open ? "true" : "false"); });
    doc.addEventListener("click", function (e) { if (!e.target.closest(".theme-pick")) { pick.classList.remove("open"); tgl.setAttribute("aria-expanded", "false"); } });
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape") pick.classList.remove("open"); });
  }
  doc.addEventListener("click", function (e) {
    var b = e.target.closest("[data-set-theme]"); if (!b) return;
    setTheme(b.getAttribute("data-set-theme"));
    if (pick) setTimeout(function () { pick.classList.remove("open"); }, 150);
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

  // ---------------------------------------------------------------- guided setup helpers
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  // Business templates fill the form; everything stays editable.
  doc.querySelectorAll("[data-template]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t; try { t = JSON.parse(b.getAttribute("data-template")); } catch (e) { return; }
      var f = doc.querySelector('form[action="/setup/business"]'); if (!f) return;
      var name = f.querySelector("[name=business_name]");
      if (window.appSetServices) window.appSetServices(t.services.split(",").map(function (x) { return x.trim(); }).filter(Boolean), t.mode || "offline");
      var bt = f.querySelector("[data-business-type]"); if (bt) bt.value = t.label;
      f.querySelector("[name=open_hour]").value = String(t.open);
      f.querySelector("[name=close_hour]").value = String(t.close);
      f.querySelector("[name=slot_minutes]").value = String(t.slot);
      f.querySelectorAll("[name=days]").forEach(function (c) { c.checked = t.days.indexOf(parseInt(c.value, 10)) >= 0; });
      // Extra info follows the chosen type, unless the person has typed their own text there.
      var extra = f.querySelector("[name=extra_info]"), keptExtra = false;
      if (extra) {
        var cur = extra.value.trim(), prev = extra.getAttribute("data-tpl-fill");
        var untouched = !cur || (prev !== null && cur === prev.trim());
        if (untouched) { extra.value = t.extra || ""; extra.setAttribute("data-tpl-fill", t.extra || ""); }
        else keptExtra = !!t.extra;
      }
      doc.querySelectorAll("[data-template]").forEach(function (x) { x.classList.toggle("picked", x === b); });
      f.querySelectorAll("input,select").forEach(function (el) { el.classList.add("flash-fill"); setTimeout(function () { el.classList.remove("flash-fill"); }, 900); });
      updateSlots();
      toast("ok", t.label + " template applied. Add your business name and adjust anything.");
      if (keptExtra) toast("info", "We kept what you wrote in Extra information. Clear it if you want the " + t.label + " suggestion.", 6000);
      if (name && !name.value) setTimeout(function () { name.focus(); }, 300);
    });
  });

  // Business-type picker: categories, search, and "Something else".
  var tplBox = doc.querySelector("[data-templates]");
  if (tplBox) {
    var cards = Array.prototype.slice.call(tplBox.querySelectorAll("[data-template]"));
    var search = doc.querySelector("[data-template-search]"), empty = doc.querySelector("[data-templates-empty]");
    var cat = "popular";
    function filter() {
      var q = (search && search.value || "").trim().toLowerCase(), n = 0;
      var words = q.split(/\s+/).filter(Boolean);
      cards.forEach(function (c, i) {
        var show = words.length
          ? words.every(function (w) { return c.getAttribute("data-search").indexOf(w) >= 0; })
          : (" " + c.getAttribute("data-cat") + " ").indexOf(" " + cat + " ") >= 0;
        if (show && c.hidden) { c.style.animationDelay = Math.min(n, 12) * 25 + "ms"; c.classList.remove("in"); void c.offsetWidth; c.classList.add("in"); }
        c.hidden = !show; if (show) n++;
      });
      if (empty) empty.hidden = n > 0;
      doc.querySelectorAll("[data-template-cat]").forEach(function (b) {
        var on = !words.length && b.getAttribute("data-template-cat") === cat;
        b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    doc.querySelectorAll("[data-template-cat]").forEach(function (b) {
      b.addEventListener("click", function () { cat = b.getAttribute("data-template-cat"); if (search) search.value = ""; filter(); });
    });
    if (search) {
      search.addEventListener("input", filter);
      search.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); var first = cards.filter(function (c) { return !c.hidden; })[0]; if (first) first.click(); }
      });
    }
    // "Skip this": jump to the form and start typing.
    var skip = doc.querySelector("[data-skip-templates]");
    if (skip) skip.addEventListener("click", function (e) {
      e.preventDefault();
      var nm = doc.querySelector('form[action="/setup/business"] [name=business_name]'); if (!nm) return;
      nm.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      setTimeout(function () { nm.focus(); nm.classList.add("flash-fill"); setTimeout(function () { nm.classList.remove("flash-fill"); }, 900); }, 350);
    });
  }

  // Live preview of the slots customers will be offered.
  var slotBox = doc.querySelector("[data-slot-preview]");
  function fmt(h, m) { var ap = h >= 12 ? "pm" : "am", hh = h % 12 || 12; return hh + (m ? ":" + (m < 10 ? "0" : "") + m : "") + " " + ap; }
  function updateSlots() {
    if (!slotBox) return;
    var f = slotBox.closest("form");
    var o = parseInt(f.querySelector("[name=open_hour]").value, 10), c = parseInt(f.querySelector("[name=close_hour]").value, 10);
    var len = parseInt(f.querySelector("[name=slot_minutes]").value, 10);
    var days = Array.prototype.filter.call(f.querySelectorAll("[name=days]"), function (x) { return x.checked; }).length;
    if (!(c > o)) { slotBox.className = "slot-preview warn"; slotBox.textContent = "Closing time must be after opening time."; return; }
    var slots = [], t = o * 60;
    var step = Math.min(len, 30);
    while (t + len <= c * 60) { slots.push(fmt(Math.floor(t / 60), t % 60)); t += step; }
    slotBox.className = "slot-preview";
    slotBox.innerHTML = "";
    var head = doc.createElement("div"); head.className = "sp-head";
    head.innerHTML = "<b></b><span></span>";
    head.querySelector("b").textContent = "Customers will see";
    head.querySelector("span").textContent = slots.length + " start times a day · " + days + " day" + (days === 1 ? "" : "s") + " a week";
    slotBox.appendChild(head);
    var row = doc.createElement("div"); row.className = "sp-row";
    slots.slice(0, 10).forEach(function (x, i) { var chip = doc.createElement("span"); chip.textContent = x; chip.style.animationDelay = (i * 25) + "ms"; row.appendChild(chip); });
    if (slots.length > 10) { var more = doc.createElement("span"); more.className = "more"; more.textContent = "+" + (slots.length - 10) + " more"; row.appendChild(more); }
    slotBox.appendChild(row);
  }
  if (slotBox) { slotBox.closest("form").addEventListener("change", updateSlots); updateSlots(); }

  // Guide steps become a checklist the user ticks off (remembered on this device).
  doc.querySelectorAll("ol.guide").forEach(function (ol, n) {
    var key = "guide:" + location.pathname + location.search + ":" + n, saved = {};
    try { saved = JSON.parse(store(key) || "{}"); } catch (e) {}
    var items = ol.querySelectorAll(":scope > li");
    var bar = doc.createElement("div"); bar.className = "guide-progress";
    bar.innerHTML = '<span></span><div class="gp-track"><i></i></div>';
    ol.parentNode.insertBefore(bar, ol);
    function refresh() {
      var done = ol.querySelectorAll(":scope > li.ticked").length;
      bar.querySelector("span").textContent = done === items.length ? "All done ✓" : done + " of " + items.length + " done";
      bar.querySelector("i").style.width = (done / items.length * 100) + "%";
      bar.classList.toggle("complete", done === items.length);
    }
    items.forEach(function (li, i) {
      var b = doc.createElement("button"); b.type = "button"; b.className = "tick-btn"; b.setAttribute("aria-label", "Mark step " + (i + 1) + " done");
      b.textContent = String(i + 1);
      li.insertBefore(b, li.firstChild); li.classList.add("checkable");
      if (saved[i]) li.classList.add("ticked");
      b.addEventListener("click", function () {
        li.classList.toggle("ticked"); saved[i] = li.classList.contains("ticked"); store(key, JSON.stringify(saved)); refresh();
        b.setAttribute("aria-pressed", saved[i] ? "true" : "false");
      });
    });
    refresh();
  });

  // Instant check of the AI key format (prefix comes from the provider).
  var keyIn = doc.querySelector('form[action="/setup/claude"] [name=api_key]');
  if (keyIn) {
    var hint = doc.createElement("div"); hint.className = "field-hint"; (keyIn.closest(".reveal") || keyIn).insertAdjacentElement("afterend", hint);
    var pre = keyIn.getAttribute("data-prefix") || "", who = keyIn.getAttribute("data-who") || "These";
    keyIn.addEventListener("input", function () {
      var v = keyIn.value.trim();
      if (!v) { hint.className = "field-hint"; hint.textContent = ""; return; }
      if (/\s/.test(v)) { hint.className = "field-hint bad"; hint.textContent = "Remove the spaces; paste only the key."; return; }
      if (pre && v.indexOf(pre) !== 0 && !(pre.indexOf(v) === 0)) { hint.className = "field-hint bad"; hint.textContent = who + " keys start with " + pre; return; }
      if (v.length >= pre.length + 20) { hint.className = "field-hint ok"; hint.textContent = "✓ Looks like a valid key. Click Test and save."; }
      else { hint.className = "field-hint"; hint.textContent = "Keep pasting… the key is longer."; }
    });
  }

  // AI version picker: highlight the chosen card, show "More versions", and load the live list on request.
  doc.querySelectorAll(".ver-list").forEach(function (list) {
    var form = list.closest("form"), more = form.querySelector(".more-ver");
    function sync() {
      list.querySelectorAll(".ver").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
      var other = form.querySelector('input[name=model][value=other]');
      if (more) { more.hidden = !(other && other.checked); if (!more.hidden) { var t = more.querySelector("[name=model_other]"); t.required = true; } else more.querySelector("[name=model_other]").required = false; }
    }
    list.addEventListener("change", sync); sync();
    var btn = form.querySelector("[data-load-models]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var msg = form.querySelector("[data-models-msg]"), dl = form.querySelector("#ai-models");
      var body = new URLSearchParams({ _csrf: form.querySelector("[name=_csrf]").value, provider: btn.getAttribute("data-load-models"), api_key: (form.querySelector("[name=api_key]").value || "").trim() });
      btn.disabled = true; msg.textContent = "Loading…";
      fetch("/setup/ai/models", { method: "POST", body: body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) { msg.textContent = j.error; return; }
          dl.innerHTML = "";
          j.models.forEach(function (m) { var o = doc.createElement("option"); o.value = m.id; if (m.label && m.label !== m.id) o.label = m.label; dl.appendChild(o); });
          msg.textContent = j.models.length + " versions found. Start typing to pick one.";
          form.querySelector("[name=model_other]").focus();
        })
        .catch(function () { msg.textContent = "Couldn't load the list. Type the version name instead."; })
        .then(function () { btn.disabled = false; });
    });
  });

  // Drag & drop for the Google key: read it in the browser first, then upload.
  doc.querySelectorAll("[data-dropzone]").forEach(function (dz) {
    var input = dz.querySelector("input[type=file]"), form = dz.closest("form");
    var title = dz.querySelector("[data-dz-title]"), sub = dz.querySelector("[data-dz-sub]");
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; handle(); } });
    input.addEventListener("change", handle);
    function handle() {
      var file = input.files && input.files[0]; if (!file) return;
      var r = new FileReader();
      r.onload = function () {
        var j = null; try { j = JSON.parse(r.result); } catch (e) {}
        if (!j || j.type !== "service_account" || !j.client_email) {
          dz.classList.add("bad"); dz.classList.remove("good");
          title.textContent = "That's not the right file";
          sub.textContent = "Use the JSON key from Google Cloud → Service account → Keys → Add key → JSON.";
          toast("err", "That file isn't a Google service-account key."); input.value = ""; return;
        }
        dz.classList.remove("bad"); dz.classList.add("good");
        title.textContent = "✓ " + file.name; sub.textContent = "Service account: " + j.client_email + " · uploading…";
        setTimeout(function () { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }, 350);
      };
      r.readAsText(file);
    }
  });

  // Widget: colour swatches + live preview.
  var prev = doc.querySelector("[data-widget-preview]");
  if (prev) {
    var colorIn = doc.querySelector("input[type=color][name=color]"), gIn = doc.querySelector("[data-preview-greeting]"), gOut = prev.querySelector("[data-greeting-out]");
    var gDefault = gOut.textContent;
    function paint(c) {
      prev.style.setProperty("--accent", c); colorIn.value = c;
      doc.querySelectorAll("[data-color]").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-color").toLowerCase() === c.toLowerCase()); });
      colorIn.closest(".swatch").classList.toggle("on", !doc.querySelector("[data-color].on"));
    }
    doc.querySelectorAll("[data-color]").forEach(function (s) { s.addEventListener("click", function () { paint(s.getAttribute("data-color")); }); });
    colorIn.addEventListener("input", function () { paint(colorIn.value); });
    gIn.addEventListener("input", function () { gOut.textContent = gIn.value.trim() || gDefault; });
    paint(colorIn.value);
  }

  // ---------------------------------------------------------------- test chat
  // ---------------------------------------------------------------- services editor (v7)
  var svcEd = doc.querySelector("[data-svc-editor]");
  if (svcEd) {
    var list = svcEd.querySelector("[data-svc-list]"), tpl = svcEd.querySelector("[data-svc-template]");
    function wire(row) {
      var kind = row.querySelector("[data-svc-kind]"), price = row.querySelector("[data-svc-price]");
      kind.addEventListener("change", function () {
        price.hidden = kind.value !== "paid";
        if (kind.value === "paid") setTimeout(function () { price.querySelector("input").focus(); }, 30);
      });
      row.querySelector("[data-svc-more]").addEventListener("click", function () {
        var d = row.querySelector("[data-svc-details]"); d.hidden = !d.hidden; row.classList.toggle("open", !d.hidden);
        if (!d.hidden) d.querySelector("textarea").focus();
      });
      row.querySelector("[data-svc-remove]").addEventListener("click", function () {
        if (list.children.length <= 1) { row.querySelectorAll("input[type=text], textarea").forEach(function (i) { i.value = ""; }); return; }
        row.classList.add("out"); setTimeout(function () { row.remove(); }, 200);
      });
      row.querySelector(".svc-name").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); addRow("", null, true); }
      });
      if (row.querySelector("[data-svc-details] textarea").value.trim()) { row.querySelector("[data-svc-details]").hidden = false; row.classList.add("open"); }
    }
    function addRow(name, mode, focus) {
      var row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector(".svc-name").value = name || "";
      if (mode) row.querySelector(".svc-mode").value = mode;
      list.appendChild(row); wire(row);
      if (focus) row.querySelector(".svc-name").focus();
      return row;
    }
    list.querySelectorAll("[data-svc-row]").forEach(wire);
    svcEd.querySelector("[data-svc-add]").addEventListener("click", function () { addRow("", null, true); });
    // Templates replace the list only if it's still empty or untouched template rows.
    window.appSetServices = function (names, mode) {
      var typed = Array.prototype.some.call(list.querySelectorAll("[data-svc-row]"), function (r) {
        return !r.hasAttribute("data-from-template") && (r.querySelector(".svc-name").value.trim() || r.querySelector("[name=svc_price]").value.trim() || r.querySelector("textarea").value.trim());
      });
      if (typed) { toast("info", "Your own services were kept. Remove them first if you want the template list.", 5000); return; }
      list.innerHTML = "";
      names.forEach(function (n) { addRow(n, mode, false).setAttribute("data-from-template", ""); });
    };
    list.addEventListener("input", function (e) { var r = e.target.closest("[data-svc-row]"); if (r) r.removeAttribute("data-from-template"); });
  }

  // Knowledge files: show what was picked.
  doc.querySelectorAll("[data-filedrop]").forEach(function (dz) {
    var input = dz.querySelector("input[type=file]"), title = dz.querySelector("[data-dz-title]"), sub = dz.querySelector("[data-dz-sub]");
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); } });
    input.addEventListener("change", show);
    function show() {
      var n = input.files.length; if (!n) return;
      dz.classList.add("good");
      title.textContent = "✓ " + (n === 1 ? input.files[0].name : n + " files");
      sub.textContent = Array.prototype.map.call(input.files, function (f) { return f.name; }).join(", ").slice(0, 120) + " · click Upload";
    }
  });

  // Payments: live price preview with the online discount.
  var disc = doc.querySelector("[data-discount]"), pp = doc.querySelector("[data-price-preview]");
  if (disc && pp) disc.addEventListener("input", function () {
    var base = +pp.getAttribute("data-list"), d = Math.max(0, Math.min(90, +disc.value || 0));
    pp.querySelector("[data-online-price]").textContent = "₹" + Math.round(base * (1 - d / 100)).toLocaleString("en-IN") + " online";
  });

  // Link fields: accept "instagram.com/me" and add https:// for the person.
  doc.addEventListener("blur", function (e) {
    var i = e.target;
    if (!i || !i.matches || !i.matches("input[data-url]")) return;
    var v = i.value.trim();
    if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && /^[\w-]+(\.[\w-]+)+/.test(v)) i.value = "https://" + v;
  }, true);

  // ---------------------------------------------------------------- booking forms: live free-slot picker (v8)
  doc.querySelectorAll("[data-slot-form]").forEach(function (form) {
    var date = form.querySelector("[data-slot-date]"), box = form.querySelector("[data-slot-pick]"), time = form.querySelector("[data-slot-time]");
    var svc = form.querySelector("[data-slot-service]"), ignore = form.getAttribute("data-ignore") || "";
    var modeF = form.querySelector("[data-mode-field]"), paidF = form.querySelector("[data-paid-field]");
    function fmt(hm) { var p = hm.split(":"), h = +p[0], m = +p[1]; return (h % 12 || 12) + (m ? ":" + p[1] : "") + (h < 12 ? " am" : " pm"); }
    function svcFields() {
      if (!svc) return;
      var o = svc.options[svc.selectedIndex];
      if (modeF) { modeF.hidden = o.getAttribute("data-mode") !== "both"; if (o.getAttribute("data-mode") !== "both") modeF.querySelector("select").value = o.getAttribute("data-mode"); }
      if (paidF) paidF.hidden = !(+o.getAttribute("data-price") > 0);
    }
    var seq = 0;
    function load() {
      time.value = ""; if (!date.value) return;
      var my = ++seq;
      box.innerHTML = '<span class="muted">Checking free times…</span>'; box.classList.add("loading-slots");
      var q = "?date=" + encodeURIComponent(date.value) + (svc ? "&service=" + encodeURIComponent(svc.value) : "") + (ignore ? "&ignore=" + encodeURIComponent(ignore) : "");
      fetch("/bookings/slots" + q, { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
        if (my !== seq) return;
        box.classList.remove("loading-slots"); box.innerHTML = "";
        if (!j.slots || !j.slots.length) { var n = doc.createElement("span"); n.className = "muted"; n.textContent = j.note || "No free times that day."; box.appendChild(n); return; }
        j.slots.forEach(function (s, i) {
          var b = doc.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = fmt(s); b.style.animationDelay = Math.min(i, 20) * 15 + "ms";
          b.addEventListener("click", function () { time.value = s; box.querySelectorAll(".chip").forEach(function (x) { x.classList.toggle("on", x === b); }); });
          box.appendChild(b);
        });
      }).catch(function () { box.innerHTML = '<span class="muted">Couldn\'t load times. Try again.</span>'; });
    }
    date.addEventListener("change", load);
    if (svc) svc.addEventListener("change", function () { svcFields(); load(); });
    svcFields(); load();
    form.addEventListener("submit", function (e) { if (!time.value) { e.preventDefault(); e.stopImmediatePropagation(); toast("err", "Pick one of the free times first."); } }, true);
  });

  // ---------------------------------------------------------------- admin helpers (v6)
  // Show / hide a panel: <button data-open="id"> and <button data-close="id">.
  doc.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]"), c = e.target.closest("[data-close]");
    if (o) {
      var p = doc.getElementById(o.getAttribute("data-open")); if (!p) return;
      p.hidden = false; p.classList.remove("reveal-in"); void p.offsetWidth; p.classList.add("reveal-in");
      p.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      var f = p.querySelector("input:not([type=hidden]):not([type=file]),select,textarea"); if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, 350);
    }
    if (c) { var q = doc.getElementById(c.getAttribute("data-close")); if (q) q.hidden = true; }
  });
  // Deep link like /admin/users/5#payments from "Record payment" opens the form straight away.
  if (location.hash === "#payments" && doc.getElementById("record-payment")) {
    var rp = doc.querySelector('[data-open="record-payment"]');
    if (rp && !doc.querySelector('[data-toast="ok"],[data-toast="err"]')) setTimeout(function () { rp.click(); }, 300);
  }

  // Quick date chips: add a period to the date field next to them.
  function addPeriod(iso, code) {
    var d = iso ? new Date(iso + "T00:00:00") : new Date();
    if (isNaN(d)) d = new Date();
    var n = parseInt(code.slice(1), 10), unit = code.slice(-1);
    if (unit === "d") d.setDate(d.getDate() + n);
    if (unit === "m") d.setMonth(d.getMonth() + n);
    if (unit === "y") d.setFullYear(d.getFullYear() + n);
    var z = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
  }
  doc.querySelectorAll("[data-quick-dates]").forEach(function (box) {
    var input = box.parentNode.querySelector("input[type=date]") || (box.closest(".grid") && box.closest(".grid").querySelector("input[type=date]"));
    if (!input) return;
    var orig = input.value;
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-add]"); if (!b) return;
      var t = addPeriod("", "+0d");
      // Always count from the same starting point, so clicking twice doesn't add up.
      var base = box.getAttribute("data-base") || (orig && orig >= t ? orig : t);
      input.value = addPeriod(base, b.getAttribute("data-add"));
      input.classList.remove("flash-fill"); void input.offsetWidth; input.classList.add("flash-fill");
      box.querySelectorAll(".chip").forEach(function (x) { x.classList.toggle("on", x === b); });
    });
  });

  // Account form: customer-only sections follow the role; the "new key" fields follow the key picker.
  doc.querySelectorAll("[data-role-form]").forEach(function (form) {
    var role = form.querySelector("[data-role-select]"), keySel = form.querySelector("[data-shared-key]"), nk = form.querySelector("[data-new-key]");
    function sync() {
      var customer = !role || role.value !== "admin";
      form.querySelectorAll("[data-customer-only]").forEach(function (el) { el.hidden = !customer; });
      if (nk && keySel) {
        var isNew = keySel.value === "new"; nk.hidden = !isNew;
        nk.querySelectorAll("input").forEach(function (i) { i.required = isNew && customer; });
      }
    }
    if (role) role.addEventListener("change", sync);
    if (keySel) keySel.addEventListener("change", function () { sync(); if (keySel.value === "new") { var i = nk.querySelector("input"); if (i) i.focus(); } });
    sync();
  });

  // Payment form: the extend fields follow the switch.
  doc.querySelectorAll("[data-extend-toggle]").forEach(function (t) {
    var f = t.closest("form").querySelector("[data-extend-fields]");
    function s() { if (f) { f.classList.toggle("dim", !t.checked); f.querySelectorAll("input,button").forEach(function (i) { i.disabled = !t.checked; }); } }
    t.addEventListener("change", s); s();
  });

  // Screenshot drop: preview, shrink big images in the browser (keeps the database small), paste with ⌘V.
  doc.querySelectorAll("[data-imagedrop]").forEach(function (dz) {
    var input = dz.querySelector("input[type=file]"), img = dz.querySelector("[data-img-preview]");
    var title = dz.querySelector("[data-dz-title]"), sub = dz.querySelector("[data-dz-sub]");
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) use(e.dataTransfer.files[0]); });
    input.addEventListener("change", function () { if (input.files[0]) use(input.files[0]); });
    doc.addEventListener("paste", function (e) {
      if (dz.closest("[hidden]")) return;
      var items = (e.clipboardData && e.clipboardData.files) || [];
      for (var i = 0; i < items.length; i++) if (/^image\//.test(items[i].type)) { use(items[i]); e.preventDefault(); return; }
    });
    function setFile(file) {
      try { var dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; } catch (e) {}
    }
    function show(file, note) {
      var url = URL.createObjectURL(file); img.src = url; img.hidden = false;
      dz.classList.add("good", "has-img"); dz.classList.remove("bad");
      title.textContent = "✓ Screenshot added"; sub.textContent = note;
    }
    function use(file) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        dz.classList.add("bad"); title.textContent = "Use a PNG or JPG image"; toast("err", "That file isn't a PNG or JPG image."); input.value = ""; return;
      }
      var kb = function (n) { return n < 1024 ? "under 1 KB" : Math.round(n / 1024) + " KB"; };
      var im = new Image();
      im.onload = function () {
        var max = 1600, s = Math.min(1, max / Math.max(im.width, im.height));
        if (s === 1 && file.size < 700 * 1024) { setFile(file); show(file, kb(file.size) + " · click to change"); return; }
        var c = doc.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
          if (!blob) { setFile(file); show(file, kb(file.size)); return; }
          var f = new File([blob], (file.name || "screenshot").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
          setFile(f); show(f, kb(f.size) + " (shrunk from " + kb(file.size) + ") · click to change");
        }, "image/jpeg", 0.82);
      };
      im.onerror = function () { setFile(file); show(file, kb(file.size)); };
      im.src = URL.createObjectURL(file);
    }
  });

  // Screenshot viewer.
  doc.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-lightbox]"); if (!a) return;
    e.preventDefault();
    var box = doc.createElement("div"); box.className = "lightbox";
    var im = doc.createElement("img"); im.src = a.getAttribute("href"); im.alt = "Payment screenshot";
    var x = doc.createElement("button"); x.type = "button"; x.className = "lb-close"; x.setAttribute("aria-label", "Close"); x.textContent = "×";
    box.appendChild(im); box.appendChild(x); doc.body.appendChild(box);
    function close() { box.classList.add("out"); doc.removeEventListener("keydown", k); setTimeout(function () { box.remove(); }, 220); }
    function k(ev) { if (ev.key === "Escape") close(); }
    box.addEventListener("click", function (ev) { if (ev.target !== im) close(); });
    doc.addEventListener("keydown", k);
  });

  // Press "/" to jump to search.
  doc.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || /INPUT|TEXTAREA|SELECT/.test((doc.activeElement || {}).tagName || "")) return;
    var s = doc.querySelector("[data-slash-focus]"); if (s) { e.preventDefault(); s.focus(); s.select(); }
  });

  // Expiry banner: "hide for now" is remembered on this device until the next day's banner.
  doc.querySelectorAll("[data-dismiss-key]").forEach(function (b) {
    var k = "dismiss:" + b.getAttribute("data-dismiss-key");
    if (store(k)) { b.remove(); return; }
    var x = b.querySelector("[data-dismiss]");
    if (x) x.addEventListener("click", function () { store(k, "1"); b.classList.add("out"); setTimeout(function () { b.remove(); }, 260); });
  });

  var chat = doc.getElementById("chat");
  if (!chat) return;
  var msgs = chat.querySelector(".msgs"), form = chat.querySelector("form"), input = form.querySelector("input"), sendBtn = form.querySelector("button");
  var csrf = chat.getAttribute("data-csrf"), waiting = false;
  function linkify(el, text) {
    el.textContent = "";
    var re = /https?:\/\/[^\s<>"')]+[^\s<>"').,!?]/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var a = doc.createElement("a"); a.href = m[0]; a.textContent = m[0].length > 48 ? m[0].slice(0, 45) + "…" : m[0];
      a.target = "_blank"; a.rel = "noopener noreferrer"; el.appendChild(a); last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(doc.createTextNode(text.slice(last)));
  }
  function add(cls, text) {
    var d = doc.createElement("div"); d.className = "m " + cls; linkify(d, text); msgs.appendChild(d);
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
    fetch(chat.getAttribute("data-endpoint"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ text: text, as: chat.getAttribute("data-as") || "customer" }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        t.remove(); add("b", j.reply || j.error || "No reply"); if (j.error) toast("err", j.error);
        if (j.firstBooking) {
          setTimeout(function () { confetti(); toast("ok", "Your first booking works! Check your Google Calendar.", 6000); }, 300);
          var cont = doc.querySelector('form[action="/setup/test/done"] button:not([type=button])'); if (cont) cont.classList.add("pulse");
        } else if (j.booked) { toast("ok", "Booked. It's in your calendar."); }
      })
      .catch(function () { t.remove(); add("b", "Network error. Try again."); toast("err", "Network error. Check your connection."); })
      .finally(function () { waiting = false; sendBtn.classList.remove("loading"); input.focus(); });
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); e.stopPropagation(); send(input.value.trim()); }, true);
  doc.querySelectorAll("[data-suggest]").forEach(function (b) { b.addEventListener("click", function () { send(b.getAttribute("data-suggest")); }); });
  var reset = doc.querySelector("[data-chat-reset]");
  if (reset) reset.addEventListener("click", function () {
    reset.classList.add("loading");
    fetch(chat.getAttribute("data-reset"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ as: chat.getAttribute("data-as") || "customer" }) })
      .then(function () { msgs.innerHTML = ""; add("b", "Started a new conversation."); toast("ok", "Conversation reset"); })
      .finally(function () { reset.classList.remove("loading"); });
  });
  doc.querySelectorAll("[data-chat-as]").forEach(function (r) {
    r.addEventListener("change", function () {
      var owner = r.value === "owner" && r.checked;
      chat.setAttribute("data-as", owner ? "owner" : "customer");
      var hint = doc.querySelector("[data-owner-hint]"), sug = doc.querySelector(".suggest");
      if (hint) hint.hidden = !owner; if (sug) sug.hidden = owner;
      msgs.innerHTML = "";
      add("b", owner ? "Hi! You're the owner here. Ask me to change services, prices, offers, holidays or see bookings." : "Hi! I'm your booking assistant. Try a suggestion above, or type anything.");
    });
  });
  add("b", "Hi! I'm your booking assistant. Try a suggestion above, or type anything.");
})();

// Setup "All steps" menu: close on outside tap or Escape.
document.addEventListener("click", function (e) {
  var d = document.querySelector("details.sn-menu[open]");
  if (d && !d.querySelector(".sn-panel").contains(e.target) && !d.querySelector("summary").contains(e.target)) d.open = false;
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") document.querySelectorAll("details.sn-menu[open]").forEach(function (d) { d.open = false; });
});

