/* Publishing Admin SPA — jason.epel.us/admin (handoff-admin.md §6).
 * Plain static JS, no build step, NO SECRETS. UI look/feel + behavior ported
 * from the david.epel.us admin SPA; the backend stays this site's job-queue
 * service on mm (verbs: rotate_code / edit_notes / archive / restore / delete —
 * pages are authored in the repo, so there is no HTML-upload flow here).
 * The login view (portrait sign-in) is deliberately unchanged. */
(function () {
  "use strict";

  // API base: the public API origin is publish.epel.us (internet-reachable,
  // Entra-gated). On the mm dev mirror it's same-origin under /admin-api;
  // anywhere else (publish.epel.us itself, or a direct service bind during
  // development) the routes are unprefixed on the same origin.
  var API =
    location.hostname === "jason.epel.us" ? "https://publish.epel.us"
    : location.hostname === "mm.epel.us" ? "/admin-api"
    : "";

  var PAGE_SIZE = 12;           // rows per page before pagination appears
  var STATUS_OPTIONS = ["Published", "Publishing", "Unpublishing", "Archived", "Failed"];

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    token: sessionStorage.getItem("adm_token") || null,
    pages: null,          // last /pages payload (kept across 401 re-logins)
    jobs: [],             // last /jobs payload (recent 50)
    search: "",
    sort: { key: "slug", desc: false },
    statusFilter: [],     // selected Status filter labels
    pageNum: 1,           // pagination (1-based)
    dismissed: {},        // job id -> true (done cards faded, failed dismissed)
    favs: {},             // slug -> true (starred; floats to the top of the list)
    favPending: {},       // slug -> true while a star write is in flight
    timers: {},
  };
  var filterPop = null;   // { overlay, pop } while the Status filter is open
  try {
    JSON.parse(localStorage.getItem("adm_dismissed") || "[]")
      .forEach(function (id) { state.dismissed[id] = true; });
  } catch (e) { /* corrupt store — start clean */ }
  function persistDismissed() {
    try {
      localStorage.setItem("adm_dismissed",
        JSON.stringify(Object.keys(state.dismissed).slice(-200)));
    } catch (e) { /* private mode etc. — dismissal just won't survive reload */ }
  }

  // Stars live in the service's DB (not localStorage), so they follow the
  // account between devices. They ride along on every /pages payload.
  function isFav(slug) { return !!state.favs[slug]; }
  function applyFavorites(list) {
    var next = {};
    (list || []).forEach(function (slug) { next[slug] = true; });
    // A star toggled a moment ago may not be in this payload yet (a poll can
    // overtake the write) — the in-flight local value wins until it lands.
    Object.keys(state.favPending).forEach(function (slug) {
      if (state.favs[slug]) next[slug] = true; else delete next[slug];
    });
    state.favs = next;
  }
  function toggleFav(slug) {
    var on = !state.favs[slug];
    if (on) state.favs[slug] = true; else delete state.favs[slug];
    state.favPending[slug] = true;
    renderTable();                                  // optimistic: no wait
    api("POST", "/favorites", { slug: slug, favorite: on }).then(function (data) {
      delete state.favPending[slug];
      applyFavorites(data.favorites);
    }).catch(function (e) {
      delete state.favPending[slug];
      if (on) delete state.favs[slug]; else state.favs[slug] = true;   // revert
      toast(e.message, true);
    }).finally(function () { renderTable(); });
  }

  // ---------------------------------------------------------------- utils --
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function icon(name) { return '<span class="material-icons-outlined">' + name + "</span>"; }
  function toast(msg, isError) {
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " err" : "");
    el.textContent = msg;
    el.addEventListener("click", function () { el.remove(); });
    $("toasts").appendChild(el);
    // Errors must be readable, not blink-and-miss: 12s + click-to-dismiss.
    setTimeout(function () { el.remove(); }, isError ? 12000 : 3200);
  }
  function copyText(text, label) {
    // Byte-exact from data via the clipboard API — never from rendered text.
    navigator.clipboard.writeText(text).then(function () {
      toast(label || "Copied to clipboard");
    }, function () { toast("Copy failed — clipboard unavailable", true); });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function fmtSize(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.ceil(bytes / 1024) + " KB";
  }
  function verbLabel(verb) { return verb.replace(/_/g, " "); }

  // ------------------------------------------------------------------ api --
  function api(method, path, body) {
    var headers = { };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: method, headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (resp) {
      if (resp.status === 401 && path !== "/session") {
        showLogin(true);          // back to login without losing the table
        throw new Error("Signed out — please sign in again.");
      }
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) throw new Error(data.error || ("Request failed (" + resp.status + ")"));
        return data;
      });
    }, function () {
      throw new Error("Can't reach the admin service.");
    });
  }

  // ---------------------------------------------------------------- views --
  function showLogin(keepData) {
    $("loginView").classList.remove("hidden");
    $("loginHeader").classList.remove("hidden");
    $("appHeader").classList.add("hidden");
    if (!keepData) $("appView").classList.add("hidden");
    state.token = null;
    sessionStorage.removeItem("adm_token");
    stopPolling();
    $("password").focus();
  }
  function showApp() {
    $("loginView").classList.add("hidden");
    $("loginHeader").classList.add("hidden");
    $("appHeader").classList.remove("hidden");
    $("appView").classList.remove("hidden");
    var name = sessionStorage.getItem("adm_name") || "Jason";
    $("userName").textContent = name;
    $("userAvatar").textContent = (name.charAt(0) || "J").toUpperCase();
    refreshPages();
    refreshJobs();
    startPolling();
  }

  // -------------------------------------------------------------- polling --
  function startPolling() {
    stopPolling();
    state.timers.pages = setInterval(refreshPages, 60000);
    state.timers.jobs = setInterval(refreshJobs, 5000);
  }
  function stopPolling() {
    Object.keys(state.timers).forEach(function (k) { clearInterval(state.timers[k]); });
    state.timers = {};
  }
  function refreshPages() {
    return api("GET", "/pages").then(function (data) {
      state.pages = data;
      applyFavorites(data.favorites);
      render();
    }).catch(function (e) { if (state.token) toast(e.message, true); });
  }
  function refreshJobs() {
    if (!state.token) return;
    return api("GET", "/jobs").then(function (data) {
      var before = activeCount();
      state.jobs = data.jobs || [];
      renderPending();
      renderTable();  // status chips depend on jobs
      if (activeCount() < before) refreshPages();  // a job just finished
    }).catch(function () { /* transient; pending strip just goes stale */ });
  }
  function activeCount() {
    return state.jobs.filter(function (j) {
      return j.state === "queued" || j.state === "running" || j.state === "verifying";
    }).length;
  }

  // ------------------------------------------------------------ job verbs --
  function postJob(verb, slug, payload, okMsg) {
    return api("POST", "/jobs", { verb: verb, slug: slug, payload: payload || {} })
      .then(function () {
        toast(okMsg || "Job queued");
        refreshJobs();
      })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------------------------------------------------------------- modal --
  var modal = { onDirtyClose: null };
  function openModal(html) {
    $("modalBox").innerHTML = html;
    $("modalBackdrop").classList.remove("hidden");
  }
  function closeModal(force) {
    if (!force && modal.onDirtyClose && modal.onDirtyClose()) return; // vetoed
    modal.onDirtyClose = null;
    $("modalBackdrop").classList.add("hidden");
    $("modalBox").innerHTML = "";
  }
  $("modalBackdrop").addEventListener("mousedown", function (e) {
    if (e.target === $("modalBackdrop")) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (filterPop) { closeFilterPop(); return; }
    var nested = document.querySelector(".scrim.nested");
    if (nested) { nested.remove(); return; }
    if (!$("modalBackdrop").classList.contains("hidden")) closeModal();
  });

  // Nested discard-confirm (david-style, replaces window.confirm).
  function showDiscardConfirm(onDiscard) {
    var d = document.createElement("div");
    d.className = "scrim nested";
    d.innerHTML =
      '<div class="modal small"><h2>Discard changes?</h2>' +
      '<p class="sub" style="margin-top:8px">Changes to the notes will be lost. Do you want to continue?</p>' +
      '<div class="actions"><button class="btn btn-quiet" id="dNo">No</button>' +
      '<button class="btn btn-danger" id="dYes">Yes, Discard</button></div></div>';
    document.body.appendChild(d);
    d.addEventListener("mousedown", function (e) { if (e.target === d) d.remove(); });
    d.querySelector("#dNo").focus();
    d.querySelector("#dNo").onclick = function () { d.remove(); };
    d.querySelector("#dYes").onclick = function () { d.remove(); onDiscard(); };
  }

  function confirmModal(title, subHtml, actionLabel, danger, onConfirm) {
    openModal(
      "<h2>" + esc(title) + "</h2>" +
      '<p class="sub" style="margin-top:8px">' + subHtml + "</p>" +
      '<div class="actions"><button class="btn btn-quiet" id="mCancel">Cancel</button>' +
      '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" id="mGo">' +
      esc(actionLabel) + "</button></div>");
    $("mCancel").onclick = function () { closeModal(true); };
    $("mGo").onclick = function () { closeModal(true); onConfirm(); };
  }

  // ------------------------------------------------------- notes editing --
  function openNotes(page) {
    openModal(
      '<div class="modal-head"><h2>Notes — ' + esc(page.slug) + "</h2>" +
      '<span class="mh-spacer"></span>' +
      '<button class="iconbtn" data-tip="Save" id="mSave" disabled>' + icon("save") + "</button>" +
      '<button class="iconbtn" data-tip="Close" id="mCloseX">' + icon("close") + "</button></div>" +
      '<textarea id="notesText" class="notes-area" maxlength="4096" placeholder="Add notes about this page…">'
      + esc(page.notes) + "</textarea>" +
      '<p class="keyhint">Cmd+Enter or Ctrl+Enter to save · Esc to close</p>');
    var ta = $("notesText"), save = $("mSave");
    var dirty = function () { return ta.value !== page.notes; };
    ta.addEventListener("input", function () { save.disabled = !dirty(); });
    modal.onDirtyClose = function () {
      if (!dirty()) return false;
      showDiscardConfirm(function () { closeModal(true); });
      return true;   // veto the close; the nested confirm decides
    };
    var doSave = function () {
      if (!dirty()) return;
      closeModal(true);
      postJob("edit_notes", page.slug, { notes: ta.value }, "Saving notes for " + page.slug + "…");
    };
    save.onclick = doSave;
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey || e.altKey) && e.key === "Enter") { e.preventDefault(); doSave(); }
    });
    $("mCloseX").onclick = function () { closeModal(); };
    ta.focus();
  }

  // --------------------------------------------------------- code reveal --
  function openCode(page) {
    openModal(
      '<div class="modal-head"><h2>Access code — ' + esc(page.slug) + "</h2>" +
      '<span class="mh-spacer"></span>' +
      '<button class="iconbtn" data-tip="Copy code" id="mCopyCode">' + icon("content_copy") + "</button>" +
      '<button class="iconbtn" data-tip="Close" id="mCloseX">' + icon("close") + "</button></div>" +
      '<div class="codereveal">' + esc(page.code) + "</div>" +
      '<p class="keyhint">Esc or click outside to close</p>');
    $("mCopyCode").onclick = function () { copyText(page.code, "Code copied"); };
    $("mCloseX").onclick = function () { closeModal(true); };
  }

  // -------------------------------------------------------- confirmations --
  function confirmRotate(page) {
    var body = "A new code will be generated for “" + esc(page.slug) +
      "” and the page re-encrypted. The current code — and every link already shared with it — stops working.";
    if (page.has_media) {
      body += '</p><p class="hint">This page’s exhibits re-encrypt on the Mac — the job runs when the Mac is awake.';
    }
    confirmModal("Rotate access code", body, "Rotate Code", false, function () {
      postJob("rotate_code", page.slug, null, "Rotation queued for " + page.slug);
    });
  }
  function confirmArchive(page) {
    confirmModal("Archive page",
      "“" + esc(page.slug) + "” will be unpublished from jason.epel.us but its source is kept and it can be restored later. " +
      "Restoring mints a new access code; title and notes are not retained.",
      "Archive", false, function () {
        postJob("archive", page.slug, null, page.slug + " archived — unpublish in progress");
      });
  }
  function confirmRestore(slug, hasMedia) {
    var body = "“" + esc(slug) + "” will be republished with a newly minted access code (the pre-archive code was retired). " +
      "Share the new secure link once it is live.";
    if (hasMedia) body += '</p><p class="hint">This page’s exhibits re-encrypt on the Mac — the job runs when the Mac is awake.';
    confirmModal("Restore page", body, "Restore", false, function () {
      postJob("restore", slug, null, slug + " restoring — a new code will be minted");
    });
  }
  function confirmDelete(slug) {
    confirmModal("Delete page",
      "“" + esc(slug) + "” will be removed from the site and its source folder deleted. This cannot be undone from the admin.",
      "Delete Permanently", true, function () {
        postJob("delete", slug, null, "Delete queued for " + slug);
      });
  }

  // -------------------------------------------------------- status logic --
  function statusFor(page, archived) {
    var active = state.jobs.filter(function (j) {
      return j.slug === page.slug &&
        (j.state === "queued" || j.state === "running" || j.state === "verifying");
    });
    if (active.length) {
      var v = active[0].verb;
      return (v === "archive" || v === "delete")
        ? { label: "Unpublishing", cls: "unpublishing" }
        : { label: "Publishing", cls: "publishing" };
    }
    if (archived) return { label: "Archived", cls: "archived" };
    if (!page.code) return { label: "Publishing", cls: "publishing" };
    var recent = state.jobs.filter(function (j) { return j.slug === page.slug && j.finished_at; })
      .sort(function (a, b) { return a.finished_at < b.finished_at ? 1 : -1; })[0];
    if (recent && recent.state === "failed") return { label: "Failed", cls: "failed" };
    return { label: "Published", cls: "published" };
  }
  function failedJobFor(slug) {
    return state.jobs.filter(function (j) { return j.slug === slug && j.state === "failed"; })
      .sort(function (a, b) { return (a.finished_at || "") < (b.finished_at || "") ? 1 : -1; })[0];
  }

  // --------------------------------------------------------------- render --
  function render() { renderTable(); renderPending(); }

  // The one place the visible order is decided — render and the click-target
  // lookup (pageForKey) both go through it, so row keys can never drift.
  // Returns the combined, filtered list: live rows (sorted, stars first) then
  // archived rows (payload order, stars first within the block).
  function visibleRows() {
    var q = state.search.trim().toLowerCase();
    var s = state.sort;
    var rows = (state.pages.pages || []).filter(function (p) {
      return !q || p.slug.toLowerCase().indexOf(q) !== -1 ||
        (p.title || "").toLowerCase().indexOf(q) !== -1;
    });
    rows.sort(function (a, b) {
      // Starred pages float to the top, sorted among themselves by the active
      // column; unstarring drops a page back into its normal position.
      var fa = isFav(a.slug) ? 0 : 1, fb = isFav(b.slug) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      var av = a[s.key] || "", bv = b[s.key] || "";
      var c = av < bv ? -1 : av > bv ? 1 : 0;
      return s.desc ? -c : c;
    });
    // Archived rows keep the payload order (they always have); stars only float
    // to the top of the archived block, never above a live page.
    var arch = (state.pages.archived || []).filter(function (p) {
      return !q || p.slug.toLowerCase().indexOf(q) !== -1;
    });
    var fav = [], rest = [];
    arch.forEach(function (p) { (isFav(p.slug) ? fav : rest).push(p); });
    var combined = rows.map(function (p) { return { p: p, archived: false }; })
      .concat(fav.concat(rest).map(function (p) { return { p: p, archived: true }; }));
    if (state.statusFilter.length) {
      combined = combined.filter(function (r) {
        return state.statusFilter.indexOf(statusFor(r.p, r.archived).label) !== -1;
      });
    }
    return combined;
  }

  // Per-option row counts for the Status filter, judged against the current
  // search only — so a filtered-out option can still be unchecked, and an
  // option that can't yield rows is dimmed. Recomputed every render, so an
  // open popover tracks live status changes from the jobs poller.
  function statusCounts() {
    var q = state.search.trim().toLowerCase();
    var counts = {};
    (state.pages.pages || []).forEach(function (p) {
      if (q && p.slug.toLowerCase().indexOf(q) === -1 &&
          (p.title || "").toLowerCase().indexOf(q) === -1) return;
      var st = statusFor(p, false).label;
      counts[st] = (counts[st] || 0) + 1;
    });
    (state.pages.archived || []).forEach(function (p) {
      if (q && p.slug.toLowerCase().indexOf(q) === -1) return;
      var st = statusFor(p, true).label;
      counts[st] = (counts[st] || 0) + 1;
    });
    return counts;
  }

  function renderTable() {
    if (!state.pages) return;
    var combined = visibleRows();
    var totalPages = Math.max(1, Math.ceil(combined.length / PAGE_SIZE));
    var cur = Math.min(state.pageNum, totalPages);
    var slice = combined.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

    $("tbody").innerHTML = slice.map(function (r, i) {
      return rowHtml(r.p, r.archived, (cur - 1) * PAGE_SIZE + i);
    }).join("");

    var none = !combined.length;
    $("pagesTable").classList.toggle("hidden", none);
    $("emptyState").classList.toggle("hidden", !none);
    if (none) {
      var q = state.search.trim();
      if (q || state.statusFilter.length) {
        $("emptyState").innerHTML =
          "No pages match the current " + (q ? "search" : "filters") + "." +
          '<div style="margin-top:12px"><button class="btn btn-quiet" id="clearAll">Clear search &amp; filters</button></div>';
        $("clearAll").onclick = function () {
          state.search = ""; $("search").value = "";
          state.statusFilter = []; state.pageNum = 1;
          closeFilterPop(); renderTable();
        };
      } else {
        $("emptyState").textContent = "No pages yet.";
      }
    }

    renderPager(combined.length, totalPages, cur);

    var s = state.sort;
    document.querySelectorAll("#pagesTable th.th-click[data-sort]").forEach(function (th) {
      var active = th.dataset.sort === s.key;
      th.querySelector(".tharrow").textContent = active ? (s.desc ? "↓" : "↑") : "";
    });
    $("statusTh").classList.toggle("th-filtered", !!state.statusFilter.length);
    renderFilterPop();
  }

  function renderPager(total, totalPages, cur) {
    var meta = state.pages;
    var count = (meta.pages || []).length + " pages · " + (meta.archived || []).length +
      " archived · " + (meta.source_commit || "?") + " · " + fmtDate(meta.generated_at);
    var html = '<span class="count">' + esc(count) + "</span>";
    if (totalPages > 1) {
      html += '<button data-pg="' + (cur - 1) + '"' + (cur === 1 ? " disabled" : "") + ">‹</button>";
      for (var i = 1; i <= totalPages; i++) {
        html += '<button data-pg="' + i + '" class="' + (cur === i ? "cur" : "") + '">' + i + "</button>";
      }
      html += '<button data-pg="' + (cur + 1) + '"' + (cur === totalPages ? " disabled" : "") + ">›</button>";
    }
    $("pager").innerHTML = html;
  }
  $("pager").addEventListener("click", function (e) {
    var el = e.target.closest("button[data-pg]");
    if (!el || el.disabled) return;
    state.pageNum = parseInt(el.dataset.pg, 10);
    renderTable();
  });

  function iconBtn(name, tip, act, k, disabled, danger) {
    return '<button class="iconbtn' + (danger ? " danger" : "") + '" data-tip="' + esc(tip) +
      '" data-act="' + act + '" data-k="' + k + '"' + (disabled ? " disabled" : "") + ">" +
      icon(name) + "</button>";
  }

  function chipHtml(st, k) {
    if (st.cls === "publishing" || st.cls === "unpublishing")
      return '<span class="chip pending"><span class="spin small"></span>' + st.label + "</span>";
    if (st.cls === "archived")
      return '<span class="chip archived">' + icon("inventory_2") + "Archived</span>";
    if (st.cls === "failed")
      return '<span class="chip failed" data-act="failchip" data-k="' + k + '">' +
        icon("error_outline") + "Failed — details</span>";
    return '<span class="chip published">' + icon("check_circle") + "Published</span>";
  }

  function rowHtml(p, archived, idx) {
    var st = statusFor(p, archived);
    var k = idx;
    var fav = isFav(p.slug);
    var star = '<button class="star' + (fav ? " on" : "") + '" data-act="fav" data-k="' + k +
      '" aria-pressed="' + (fav ? "true" : "false") +
      '" title="' + (fav ? "Unstar — sort this page normally" : "Star — keep this page at the top") +
      '" aria-label="' + (fav ? "Unstar " : "Star ") + esc(p.slug) + '">' +
      (fav ? "★" : "☆") + "</button>";
    var pageCell = '<td><div class="pagecell">' + star + '<div class="pagetext">' +
      '<div class="pgname">' + esc(p.slug) + "</div>" +
      (!archived && p.title ? '<div class="pgtitle">' + esc(p.title) + "</div>" : "") +
      "</div></div></td>";
    var notes;
    if (archived) {
      notes = '<td class="notes"><span class="pgtitle" title="Notes are lost on archive">—</span></td>';
    } else {
      notes = '<td class="notes notes-edit" data-act="notes" data-k="' + k + '" title="' +
        esc(p.notes ? p.notes + "\n\n(click to edit)" : "Click to add notes") + '">' +
        (p.notes ? esc(p.notes) : "—") +
        '<span class="material-icons-outlined noteicon">edit</span></td>';
    }
    var urlCell;
    if (archived) {
      urlCell = '<td><span class="pgtitle">unpublished</span></td>';
    } else {
      var path = (p.url || "").replace(/^https?:\/\/[^/]+/, "");
      urlCell = '<td><div class="urlcell">' +
        '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(path) + "</a>" +
        iconBtn("content_copy", "Copy URL", "copyurl", k) +
        iconBtn("enhanced_encryption", "Copy secure link (URL + code)", "copydeep", k, !p.deep_link) +
        "</div></td>";
    }
    var codeCell;
    if (archived) {
      codeCell = '<td><span class="pgtitle">—</span></td>';
    } else if (p.code) {
      codeCell = '<td><div class="codecell"><span class="codeval">•••••••••••••</span>' +
        iconBtn("visibility", "Reveal code", "reveal", k) +
        iconBtn("content_copy", "Copy code", "copycode", k) +
        "</div></td>";
    } else {
      codeCell = '<td><span class="pgtitle">pending</span></td>';
    }
    var size = '<td class="nowrap">' + (p.enc_size != null ? fmtSize(p.enc_size) : "—") + "</td>";
    var when = '<td class="nowrap">' + fmtDate(archived ? p.archived_at : p.last_published) + "</td>";
    var actions;
    if (archived) {
      actions = iconBtn("restore", "Restore (republish, new code)", "restore", k) +
        iconBtn("delete_outline", "Delete permanently", "delete", k, false, true);
    } else {
      actions = iconBtn("lock_reset", "Rotate access code", "rotate", k) +
        iconBtn("inventory_2", "Archive (unpublish)", "archive", k) +
        iconBtn("delete_outline", "Delete permanently", "delete", k, false, true);
    }
    return "<tr>" + pageCell +
      "<td>" + chipHtml(st, k) + "</td>" +
      notes + urlCell + codeCell + size + when +
      '<td><div class="rowactions">' + actions + "</div></td></tr>";
  }

  function pageForKey(key) {
    // Recompute the same filtered/sorted list the last render used.
    return visibleRows()[parseInt(key, 10)];
  }

  $("tbody").addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el || !state.pages || el.disabled) return;
    var r = pageForKey(el.dataset.k);
    if (!r) return;
    var page = r.p, archived = r.archived;
    switch (el.dataset.act) {
      case "fav": toggleFav(page.slug); break;
      case "notes": if (!archived) openNotes(page); break;
      case "copyurl": copyText(page.url, "URL copied"); break;
      case "copydeep":
        if (!page.deep_link) { toast("No code yet — page is still publishing", true); break; }
        copyText(page.deep_link, "Secure link copied"); break;
      case "reveal": openCode(page); break;
      case "copycode": copyText(page.code, "Code copied"); break;
      case "rotate": confirmRotate(page); break;
      case "archive": confirmArchive(page); break;
      case "restore": confirmRestore(page.slug, !!page.has_media); break;
      case "delete": confirmDelete(page.slug); break;
      case "failchip":
        var job = failedJobFor(page.slug);
        if (job) openFailure(job);
        break;
    }
  });

  // -------------------------------------------------------- status filter --
  function closeFilterPop() {
    if (!filterPop) return;
    filterPop.overlay.remove();
    filterPop.pop.remove();
    filterPop = null;
  }
  function openFilterPop() {
    if (filterPop) { closeFilterPop(); return; }
    var r = $("statusTh").getBoundingClientRect();
    var overlay = document.createElement("div");
    overlay.className = "filter-overlay";
    overlay.addEventListener("click", closeFilterPop);
    var pop = document.createElement("div");
    pop.className = "filter-pop";
    pop.style.left = r.left + "px";
    pop.style.top = (r.bottom + 2) + "px";
    document.body.appendChild(overlay);
    document.body.appendChild(pop);
    filterPop = { overlay: overlay, pop: pop };
    renderFilterPop();
  }
  function renderFilterPop() {
    if (!filterPop || !state.pages) return;
    var counts = statusCounts();
    var sel = state.statusFilter;
    filterPop.pop.innerHTML = STATUS_OPTIONS.map(function (opt) {
      // An option that can't yield rows (given the search) is dimmed and
      // unclickable — unless it's already selected, so it can still be
      // unchecked. Recomputed on every render, so it tracks live status
      // changes from the jobs poller.
      var dead = !(counts[opt] > 0) && sel.indexOf(opt) === -1;
      return '<label class="' + (dead ? "dead" : "") + '"><input type="checkbox" data-opt="' + opt + '"' +
        (dead ? " disabled" : "") + (sel.indexOf(opt) !== -1 ? " checked" : "") + "> " + opt + "</label>";
    }).join("") +
      '<button class="clearbtn"' + (sel.length ? "" : " disabled") + ">Clear filter</button>";
    filterPop.pop.querySelectorAll("input[data-opt]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var opt = cb.dataset.opt;
        var i = state.statusFilter.indexOf(opt);
        if (i === -1) state.statusFilter.push(opt); else state.statusFilter.splice(i, 1);
        state.pageNum = 1;
        renderTable();
      });
    });
    filterPop.pop.querySelector(".clearbtn").addEventListener("click", function () {
      state.statusFilter = [];
      state.pageNum = 1;
      closeFilterPop();
      renderTable();
    });
  }
  $("statusTh").addEventListener("click", openFilterPop);

  // -------------------------------------------------------- pending strip --
  function jobSub(j) {
    if (j.state === "queued") return j.requires === "mac" ? "Queued — waiting for the Mac" : "Queued…";
    if (j.state === "running") return "Waiting for the process to finish…";
    if (j.state === "verifying") return "Verifying the result on the live site…";
    if (j.state === "failed") return j.error || "The job did not complete.";
    switch (j.verb) {   // done
      case "archive": return "Unpublished — the page now returns 404";
      case "delete": return "Deleted — the page now returns 404";
      case "rotate_code": return "Done — a new code was minted";
      case "restore": return "Republished — a new code was minted";
      case "edit_notes": return "Notes saved";
      default: return "Done";
    }
  }
  function renderPending() {
    var show = state.jobs.filter(function (j) {
      if (j.state === "queued" || j.state === "running" || j.state === "verifying") return true;
      if (j.state === "failed") return !state.dismissed[j.id];
      if (j.state === "done") {
        if (state.dismissed[j.id]) return false;
        // Fade success cards 60 s after they finish.
        if (j.finished_at && Date.now() - new Date(j.finished_at).getTime() > 60000) {
          state.dismissed[j.id] = true;
          persistDismissed();
          return false;
        }
        return true;
      }
      return false;
    });
    $("pendingStrip").classList.toggle("hidden", !show.length);
    $("pendingStrip").innerHTML = show.map(function (j) {
      var active = j.state === "queued" || j.state === "running" || j.state === "verifying";
      var lead = active ? '<span class="spin"></span>'
        : j.state === "done" ? '<span class="check">' + icon("check_circle") + "</span>"
        : '<span class="failx">' + icon("error_outline") + "</span>";
      var right = "";
      if (j.state === "queued") {
        right = '<button class="btn btn-quiet" data-jact="cancel" data-jid="' + j.id + '">Cancel</button>';
      } else if (j.state === "failed") {
        right = '<button class="btn btn-quiet" data-jact="details" data-jid="' + j.id + '">Details</button>' +
          ' <button class="btn btn-quiet" data-jact="dismiss" data-jid="' + j.id + '">Dismiss</button>';
      } else if (j.state === "done" && (j.verb === "rotate_code" || j.verb === "restore")) {
        var pg = ((state.pages || {}).pages || []).find(function (p) { return p.slug === j.slug; });
        if (pg && pg.deep_link) {
          right = '<button class="btn btn-quiet" data-jact="securelink" data-jid="' + j.id + '">' +
            icon("enhanced_encryption") + " Copy secure link</button>";
        }
      }
      return '<div class="card pending-card ' + (j.state === "done" ? "ok" : j.state === "failed" ? "err" : "") + '">' +
        lead +
        '<div class="pc-body"><div class="name">' + esc(j.slug) +
        ' <span class="sub">· ' + esc(verbLabel(j.verb)) + "</span></div>" +
        '<div class="sub">' + esc(jobSub(j)) + "</div></div>" +
        right + "</div>";
    }).join("");
  }

  $("pendingStrip").addEventListener("click", function (e) {
    var el = e.target.closest("[data-jact]");
    if (!el) return;
    var job = state.jobs.find(function (j) { return j.id === el.dataset.jid; });
    if (!job) return;
    if (el.dataset.jact === "cancel") {
      api("DELETE", "/jobs/" + job.id).then(function () {
        toast("Job cancelled"); refreshJobs();
      }).catch(function (err) { toast(err.message, true); refreshJobs(); });
    } else if (el.dataset.jact === "dismiss") {
      state.dismissed[job.id] = true;
      persistDismissed();
      renderPending();
    } else if (el.dataset.jact === "details") {
      openFailure(job);
    } else if (el.dataset.jact === "securelink") {
      var pg = ((state.pages || {}).pages || []).find(function (p) { return p.slug === job.slug; });
      if (pg && pg.deep_link) copyText(pg.deep_link, "Secure link copied");
    }
  });

  function openFailure(job) {
    var host = job.requires === "mac" ? "the Mac" : "mm";
    var prompt = "Admin job " + job.id + ": " + job.verb + " on p/" + job.slug +
      "/ failed at " + (job.finished_at || job.reported_at || job.created_at) +
      " on " + host + ". Error: " + (job.error || "(none recorded)") +
      ". Pipeline is publish.py per handoff-admin.md — investigate on the executor host.";
    openModal(
      "<h2>Failed — " + esc(verbLabel(job.verb)) + " " + esc(job.slug) + "</h2>" +
      '<p class="sub" style="margin-top:8px">Created ' + esc(fmtDate(job.created_at)) +
      (job.started_at ? " · started " + esc(fmtDate(job.started_at)) : "") +
      (job.finished_at ? " · failed " + esc(fmtDate(job.finished_at)) : "") +
      " · executor: " + esc(host) + "</p>" +
      '<div class="copyblock">' + esc(job.error || "(no error text recorded)") + "</div>" +
      "<label>Investigation prompt (paste into Claude)</label>" +
      '<div class="copyblock">' + esc(prompt) + "</div>" +
      '<div class="actions">' +
      '<button class="btn btn-quiet" id="mCopyPrompt">' + icon("content_copy") + " Copy Prompt</button>" +
      '<button class="btn btn-primary" id="mClose">Close</button></div>');
    $("mCopyPrompt").onclick = function () { copyText(prompt, "Prompt copied"); };
    $("mClose").onclick = function () { closeModal(true); };
  }

  // -------------------------------------------------------------- search --
  $("search").addEventListener("input", function () {
    state.search = this.value;
    state.pageNum = 1;
    renderTable();
  });
  document.querySelectorAll("#pagesTable th.th-click[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      if (state.sort.key === th.dataset.sort) state.sort.desc = !state.sort.desc;
      // Dates sort newest-first on first click; names A-Z.
      else state.sort = { key: th.dataset.sort, desc: th.dataset.sort === "last_published" };
      state.pageNum = 1;
      renderTable();
    });
  });

  // --------------------------------------------------------------- login --
  // Live mode signs in through Entra ID (auth code + PKCE); the password form
  // survives only for fixture/dev mode, driven by GET /auth-config.
  var authCfg = null;

  function b64urlOf(buf) {
    var s = "";
    new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randToken(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64urlOf(a.buffer);
  }
  function redirectUri() {
    var p = location.pathname.endsWith("/") ? location.pathname : location.pathname + "/";
    return location.origin + p;
  }
  function startMsLogin() {
    var verifier = randToken(48), st = randToken(16), nonce = randToken(16);
    sessionStorage.setItem("adm_pkce", verifier);
    sessionStorage.setItem("adm_state", st);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (d) {
      location.assign(
        "https://login.microsoftonline.com/" + authCfg.tenant_id +
        "/oauth2/v2.0/authorize?client_id=" + encodeURIComponent(authCfg.client_id) +
        "&response_type=code&redirect_uri=" + encodeURIComponent(redirectUri()) +
        // `profile` is required or the ID token carries no `oid` claim — and the
        // service pins oid. Without it every sign-in ends in "sign-in rejected".
        "&scope=openid%20profile&response_mode=query&code_challenge_method=S256" +
        "&code_challenge=" + b64urlOf(d) + "&state=" + st + "&nonce=" + nonce);
    });
  }
  function rememberName(idToken) {
    // Display-only: the header greets by the token's given_name. Auth stays
    // entirely server-side (the service validates the token itself).
    try {
      var claims = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      var name = claims.given_name || (claims.name || "").split(" ")[0];
      if (name) sessionStorage.setItem("adm_name", name);
    } catch (e) { /* header just says Jason */ }
  }
  function finishMsLogin() {
    // True when this page load is the redirect back from Entra.
    var qs = new URLSearchParams(location.search);
    if (!qs.has("code") && !qs.has("error")) return false;
    history.replaceState(null, "", redirectUri());
    showLogin(false);
    if (qs.has("error")) {
      $("loginError").textContent = qs.get("error_description") || qs.get("error");
      return true;
    }
    if (qs.get("state") !== sessionStorage.getItem("adm_state")) {
      $("loginError").textContent = "Sign-in state mismatch — try again.";
      return true;
    }
    $("loginError").textContent = "Signing in…";
    fetch("https://login.microsoftonline.com/" + authCfg.tenant_id + "/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: authCfg.client_id,
        grant_type: "authorization_code",
        code: qs.get("code"),
        redirect_uri: redirectUri(),
        code_verifier: sessionStorage.getItem("adm_pkce") || "",
      }).toString(),
    }).then(function (r) { return r.json(); }).then(function (tok) {
      if (!tok.id_token) throw new Error(tok.error_description || "Sign-in failed.");
      rememberName(tok.id_token);
      return api("POST", "/session", { id_token: tok.id_token });
    }).then(function (data) {
      state.token = data.token;
      sessionStorage.setItem("adm_token", data.token);
      $("loginError").textContent = "";
      showApp();
    }).catch(function (err) {
      $("loginError").textContent = err.message;
    }).finally(function () {
      sessionStorage.removeItem("adm_pkce");
      sessionStorage.removeItem("adm_state");
    });
    return true;
  }

  var portraitActive = false;   // true => forehead click is the ONLY trigger

  $("forehead").addEventListener("click", function () {
    if (authCfg && authCfg.mode === "entra") startMsLogin();
  });
  $("portraitImg").addEventListener("error", function () {
    // No me.jpg published (or it failed to load): fall back to the button.
    portraitActive = false;
    $("portrait").classList.add("hidden");
    $("loginTitle").classList.remove("hidden");
    $("loginSubmit").classList.remove("hidden");
  });

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!authCfg) { boot(); return; }             // config fetch failed — retry
    if (authCfg.mode === "entra") {
      if (!portraitActive) startMsLogin();        // portrait mode: forehead only
      return;
    }
    var btn = $("loginSubmit");
    btn.disabled = true;
    $("loginError").textContent = "";
    api("POST", "/session", { password: $("password").value }).then(function (data) {
      state.token = data.token;
      sessionStorage.setItem("adm_token", data.token);
      $("password").value = "";
      showApp();
    }).catch(function (err) {
      $("loginError").textContent = err.message;
    }).finally(function () { btn.disabled = false; });
  });
  $("logoutBtn").addEventListener("click", function () {
    api("DELETE", "/session").catch(function () {});
    state.pages = null;
    state.favs = {};
    closeFilterPop();
    showLogin(false);
  });

  // --------------------------------------------------------------- theme --
  function effTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light" : "dark";
  }
  function updateThemeUI() {
    var dark = effTheme() === "dark";
    $("themeIcon").textContent = dark ? "light_mode" : "dark_mode";
    $("themeToggleApp").setAttribute("data-tip", dark ? "Switch to light mode" : "Switch to dark mode");
  }
  function toggleTheme() {
    var next = effTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    sessionStorage.setItem("adm_theme", next);
    updateThemeUI();
  }
  $("themeToggle").addEventListener("click", toggleTheme);
  $("themeToggleApp").addEventListener("click", toggleTheme);
  updateThemeUI();

  // ---------------------------------------------------------------- boot --
  function boot() {
    fetch(API + "/auth-config").then(function (r) { return r.json(); }).then(function (cfg) {
      authCfg = cfg;
      var pw = cfg.mode !== "entra";
      $("password").classList.toggle("hidden", !pw);
      $("password").required = pw;
      $("loginSubmit").textContent = pw ? "Sign in" : "Sign in with Microsoft";
      if (!pw) {
        // Entra mode: prefer the portrait; the img error handler reverts to the
        // button if me.jpg is missing. complete+naturalWidth covers cached 404s.
        portraitActive = true;
        $("portrait").classList.remove("hidden");
        $("loginTitle").classList.add("hidden");
        $("loginSubmit").classList.add("hidden");
        var img = $("portraitImg");
        if (img.complete && img.naturalWidth === 0) img.dispatchEvent(new Event("error"));
      }
      if (finishMsLogin()) return;
      if (state.token) showApp(); else showLogin(false);
    }).catch(function () {
      showLogin(false);
      $("loginError").textContent = "Can't reach the admin service.";
    });
  }
  boot();
})();
