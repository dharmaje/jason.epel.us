/* Publishing Admin SPA — jason.epel.us/admin (handoff-admin.md §6).
 * Plain static JS, no build step, no external assets, NO SECRETS.
 * API: the mm.epel.us service. All copy stays vague pre-login. */
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

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    token: sessionStorage.getItem("adm_token") || null,
    pages: null,          // last /pages payload (kept across 401 re-logins)
    jobs: [],             // last /jobs payload (recent 50)
    search: "",
    sort: { key: "slug", desc: false },
    dismissed: {},        // job id -> true (done cards faded out)
    timers: {},
  };

  // ---------------------------------------------------------------- utils --
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg, isError) {
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = msg;
    el.addEventListener("click", function () { el.remove(); });
    $("toasts").appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 12000 : 3000);
  }
  function copyText(text, btn) {
    // Byte-exact from data via the clipboard API — never from rendered text.
    navigator.clipboard.writeText(text).then(function () {
      if (btn) {
        btn.classList.add("copied");
        setTimeout(function () { btn.classList.remove("copied"); }, 1200);
      }
    }, function () { toast("Copy failed — clipboard unavailable", true); });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

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
    $("logoutBtn").classList.add("hidden");
    if (!keepData) $("appView").classList.add("hidden");
    state.token = null;
    sessionStorage.removeItem("adm_token");
    stopPolling();
    $("password").focus();
  }
  function showApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("logoutBtn").classList.remove("hidden");
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
    if (e.key === "Escape" && !$("modalBackdrop").classList.contains("hidden")) closeModal();
  });

  function confirmModal(title, bodyHtml, actionLabel, danger, onConfirm) {
    openModal(
      "<h2>" + esc(title) + "</h2>" + bodyHtml +
      '<div class="btnrow"><button class="btn" id="mCancel">Cancel</button>' +
      '<button class="btn ' + (danger ? "danger" : "primary") + '" id="mGo">' +
      esc(actionLabel) + "</button></div>");
    $("mCancel").onclick = function () { closeModal(true); };
    $("mGo").onclick = function () { closeModal(true); onConfirm(); };
  }

  // ------------------------------------------------------- notes editing --
  function openNotes(page) {
    openModal(
      "<h2>Notes — " + esc(page.slug) + "</h2>" +
      '<textarea id="notesText" maxlength="4096" placeholder="Internal notes for this page…">'
      + esc(page.notes) + "</textarea>" +
      '<div class="btnrow"><button class="btn" id="mCancel">Cancel</button>' +
      '<button class="btn primary" id="mSave" disabled>Save</button></div>');
    var ta = $("notesText"), save = $("mSave");
    var dirty = function () { return ta.value !== page.notes; };
    ta.addEventListener("input", function () { save.disabled = !dirty(); });
    modal.onDirtyClose = function () {
      if (!dirty()) return false;
      return !window.confirm("Discard unsaved changes to these notes?");
    };
    var doSave = function () {
      if (!dirty()) return;
      closeModal(true);
      postJob("edit_notes", page.slug, { notes: ta.value }, "Saving notes…");
    };
    save.onclick = doSave;
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doSave();
    });
    $("mCancel").onclick = function () { closeModal(); };
    ta.focus();
  }

  // --------------------------------------------------------- code reveal --
  function openCode(page) {
    openModal(
      "<h2>Access code — " + esc(page.slug) + "</h2>" +
      '<div class="bigcode" id="bigCode">' + esc(page.code) + "</div>" +
      '<div class="btnrow"><button class="btn" id="mCopyCode">Copy code</button>' +
      '<button class="btn primary" id="mClose">Close</button></div>');
    $("mCopyCode").onclick = function () { copyText(page.code, $("mCopyCode")); };
    $("mClose").onclick = function () { closeModal(true); };
  }

  // -------------------------------------------------------- confirmations --
  function confirmRotate(page) {
    var body = "<p>Every existing link and shared code stops working.</p>";
    if (page.has_media) {
      body += '<p class="dim">This page’s exhibits re-encrypt on the Mac — it runs when the Mac is awake.</p>';
    }
    confirmModal("Rotate code — " + page.slug, body, "Rotate code", true, function () {
      postJob("rotate_code", page.slug, null, "Rotation queued");
    });
  }
  function confirmArchive(page) {
    confirmModal("Archive — " + page.slug,
      "<p>Takes the page offline. Title and notes are lost. Restoring mints a NEW code.</p>",
      "Archive", true, function () {
        postJob("archive", page.slug, null, "Archive queued");
      });
  }
  function confirmRestore(slug, hasMedia) {
    var body = "<p>Republishes as a new page with a NEW code; old links stay dead.</p>";
    if (hasMedia) body += '<p class="dim">This page’s exhibits re-encrypt on the Mac — it runs when the Mac is awake.</p>';
    confirmModal("Restore — " + slug, body, "Restore", false, function () {
      postJob("restore", slug, null, "Restore queued");
    });
  }
  function confirmDelete(slug) {
    confirmModal("Delete — " + slug,
      "<p>Removes the source folder and the published page.</p>",
      "Delete", true, function () {
        postJob("delete", slug, null, "Delete queued");
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

  // --------------------------------------------------------------- render --
  function render() { renderTable(); renderPending(); renderMeta(); }

  function renderMeta() {
    if (!state.pages) return;
    $("meta").textContent = (state.pages.pages || []).length + " pages · " +
      (state.pages.archived || []).length + " archived · " +
      (state.pages.source_commit || "?") + " · " + fmtDate(state.pages.generated_at);
  }

  function renderTable() {
    if (!state.pages) return;
    var q = state.search.trim().toLowerCase();
    var rows = (state.pages.pages || []).filter(function (p) {
      return !q || p.slug.toLowerCase().indexOf(q) !== -1 ||
        (p.title || "").toLowerCase().indexOf(q) !== -1;
    });
    var s = state.sort;
    rows.sort(function (a, b) {
      var av = a[s.key] || "", bv = b[s.key] || "";
      var c = av < bv ? -1 : av > bv ? 1 : 0;
      return s.desc ? -c : c;
    });
    var archived = (state.pages.archived || []).filter(function (p) {
      return !q || p.slug.toLowerCase().indexOf(q) !== -1;
    });

    var html = rows.map(function (p, i) { return rowHtml(p, false, i); }).join("")
      + archived.map(function (p, i) { return rowHtml(p, true, i); }).join("");
    $("tbody").innerHTML = html;
    var none = !rows.length && !archived.length;
    $("emptyState").classList.toggle("hidden", !none);
    if (none) {
      $("emptyState").textContent = q ? "No pages match your search." : "No pages yet.";
    }
    $("clearSearch").classList.toggle("hidden", !q);

    document.querySelectorAll("#pagesTable th.sortable").forEach(function (th) {
      th.classList.toggle("sorted", th.dataset.sort === s.key);
      th.classList.toggle("desc", th.dataset.sort === s.key && s.desc);
    });
  }

  function rowHtml(p, archived, idx) {
    var st = statusFor(p, archived);
    var key = (archived ? "a" : "p") + idx;
    var notes;
    if (archived) {
      notes = '<td class="notes-cell disabled empty">notes lost on archive</td>';
    } else {
      notes = '<td class="notes-cell' + (p.notes ? "" : " empty") + '" data-act="notes" data-k="' + key + '" title="' +
        esc(p.notes || "Click to add notes") + '">' + (p.notes ? esc(p.notes) : "add notes…") + "</td>";
    }
    var urlCell = archived ? '<td class="nowrap">—</td>' :
      '<td class="nowrap"><span class="cellbtns">' +
      '<button class="mini" data-act="copyurl" data-k="' + key + '" title="Copy public URL">Copy URL</button>' +
      '<button class="mini" data-act="copydeep" data-k="' + key + '" title="Copy auto-unlock link (embeds the code — share as carefully as the code)">Copy secure link</button>' +
      "</span></td>";
    var codeCell = archived ? "<td>—</td>" :
      '<td class="nowrap"><span class="cellbtns"><span class="code-mask mono">•••</span>' +
      (p.code ? '<button class="mini" data-act="reveal" data-k="' + key + '" title="Reveal access code">Reveal</button>' +
        '<button class="mini" data-act="copycode" data-k="' + key + '" title="Copy access code">Copy</button>' : "") +
      "</span></td>";
    var actions;
    if (archived) {
      actions =
        '<button class="mini" data-act="restore" data-k="' + key + '" title="Restore (republishes with a NEW code)">Restore</button> ' +
        '<button class="mini danger" data-act="delete" data-k="' + key + '" title="Delete the source folder">Delete</button>';
    } else {
      actions =
        '<button class="mini" data-act="rotate" data-k="' + key + '" title="Rotate access code">Rotate</button> ' +
        '<button class="mini" data-act="archive" data-k="' + key + '" title="Take offline (keeps source)">Archive</button> ' +
        '<button class="mini danger" data-act="delete" data-k="' + key + '" title="Delete the source folder and the published page">Delete</button>';
    }
    return "<tr" + (archived ? ' class="archived"' : "") + ">" +
      '<td class="page"><div class="slug mono">' + esc(p.slug) + "</div>" +
      (archived ? "" : '<div class="title">' + esc(p.title || "") + "</div>") + "</td>" +
      '<td><span class="chip ' + st.cls + '">' + st.label + "</span></td>" +
      notes + urlCell + codeCell +
      '<td class="nowrap">' + fmtDate(archived ? p.archived_at : p.last_published) + "</td>" +
      '<td class="actions">' + actions + "</td></tr>";
  }

  function pageForKey(key) {
    // Recompute the same filtered/sorted lists the last render used.
    var q = state.search.trim().toLowerCase();
    var archived = key[0] === "a";
    var idx = parseInt(key.slice(1), 10);
    if (archived) {
      var arch = (state.pages.archived || []).filter(function (p) {
        return !q || p.slug.toLowerCase().indexOf(q) !== -1;
      });
      return arch[idx];
    }
    var rows = (state.pages.pages || []).filter(function (p) {
      return !q || p.slug.toLowerCase().indexOf(q) !== -1 ||
        (p.title || "").toLowerCase().indexOf(q) !== -1;
    });
    var s = state.sort;
    rows.sort(function (a, b) {
      var av = a[s.key] || "", bv = b[s.key] || "";
      var c = av < bv ? -1 : av > bv ? 1 : 0;
      return s.desc ? -c : c;
    });
    return rows[idx];
  }

  $("tbody").addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el || !state.pages) return;
    var page = pageForKey(el.dataset.k);
    if (!page) return;
    var archived = el.dataset.k[0] === "a";
    switch (el.dataset.act) {
      case "notes": if (!archived) openNotes(page); break;
      case "copyurl": copyText(page.url, el); break;
      case "copydeep":
        if (!page.deep_link) { toast("No code yet — page is still publishing", true); break; }
        copyText(page.deep_link, el); break;
      case "reveal": openCode(page); break;
      case "copycode": copyText(page.code, el); break;
      case "rotate": confirmRotate(page); break;
      case "archive": confirmArchive(page); break;
      case "restore": confirmRestore(page.slug, !!page.has_media); break;
      case "delete": confirmDelete(page.slug); break;
    }
  });

  // -------------------------------------------------------- pending strip --
  function renderPending() {
    var show = state.jobs.filter(function (j) {
      if (j.state === "queued" || j.state === "running" || j.state === "verifying") return true;
      if (j.state === "failed") return !state.dismissed[j.id];
      if (j.state === "done") {
        if (state.dismissed[j.id]) return false;
        // Fade success cards 60 s after they finish.
        if (j.finished_at && Date.now() - new Date(j.finished_at).getTime() > 60000) {
          state.dismissed[j.id] = true;
          return false;
        }
        return true;
      }
      return false;
    });
    $("pendingStrip").classList.toggle("hidden", !show.length);
    $("pendingStrip").innerHTML = show.map(function (j) {
      var label =
        j.state === "queued" ? (j.requires === "mac" ? "Queued — waiting for the Mac" : "Queued") :
        j.state === "running" ? "Running" :
        j.state === "verifying" ? "Verifying" :
        j.state === "done" ? "Done" : "Failed";
      var right = "";
      if (j.state === "queued") {
        right = '<button class="mini" data-jact="cancel" data-jid="' + j.id + '">Cancel</button>';
      } else if (j.state === "failed") {
        right = '<button class="mini danger" data-jact="details" data-jid="' + j.id + '">Details</button>' +
          ' <button class="mini" data-jact="dismiss" data-jid="' + j.id + '">Dismiss</button>';
      }
      return '<div class="jobcard ' + j.state + '">' +
        '<span class="jslug mono">' + esc(j.slug) + "</span>" +
        "<span>" + esc(j.verb.replace("_", " ")) + "</span>" +
        '<span class="jstate">' + label + "</span>" +
        '<span class="spacer"></span>' + right + "</div>";
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
      renderPending();
    } else if (el.dataset.jact === "details") {
      openFailure(job);
    }
  });

  function openFailure(job) {
    var host = job.requires === "mac" ? "the Mac" : "mm";
    var prompt = "Admin job " + job.id + ": " + job.verb + " on p/" + job.slug +
      "/ failed at " + (job.finished_at || job.reported_at || job.created_at) +
      " on " + host + ". Error: " + (job.error || "(none recorded)") +
      ". Pipeline is publish.py per handoff-admin.md — investigate on the executor host.";
    openModal(
      "<h2>Failed — " + esc(job.verb.replace("_", " ")) + " " + esc(job.slug) + "</h2>" +
      '<p class="dim">Created ' + esc(fmtDate(job.created_at)) +
      (job.started_at ? " · started " + esc(fmtDate(job.started_at)) : "") +
      (job.finished_at ? " · failed " + esc(fmtDate(job.finished_at)) : "") +
      " · executor: " + esc(host) + "</p>" +
      '<pre class="errbox">' + esc(job.error || "(no error text recorded)") + "</pre>" +
      '<div class="btnrow">' +
      '<button class="btn" id="mCopyPrompt">Copy investigation prompt</button>' +
      '<button class="btn primary" id="mClose">Close</button></div>');
    $("mCopyPrompt").onclick = function () { copyText(prompt, $("mCopyPrompt")); };
    $("mClose").onclick = function () { closeModal(true); };
  }

  // -------------------------------------------------------------- search --
  $("search").addEventListener("input", function () {
    state.search = this.value;
    renderTable();
  });
  $("clearSearch").addEventListener("click", function () {
    state.search = ""; $("search").value = ""; renderTable();
  });
  document.querySelectorAll("#pagesTable th.sortable").forEach(function (th) {
    th.addEventListener("click", function () {
      if (state.sort.key === th.dataset.sort) state.sort.desc = !state.sort.desc;
      else state.sort = { key: th.dataset.sort, desc: false };
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
        "&scope=openid&response_mode=query&code_challenge_method=S256" +
        "&code_challenge=" + b64urlOf(d) + "&state=" + st + "&nonce=" + nonce);
    });
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

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!authCfg) { boot(); return; }             // config fetch failed — retry
    if (authCfg.mode === "entra") { startMsLogin(); return; }
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
    showLogin(false);
  });

  // --------------------------------------------------------------- theme --
  $("themeToggle").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    sessionStorage.setItem("adm_theme", next);
  });

  // ---------------------------------------------------------------- boot --
  function boot() {
    fetch(API + "/auth-config").then(function (r) { return r.json(); }).then(function (cfg) {
      authCfg = cfg;
      var pw = cfg.mode !== "entra";
      $("password").classList.toggle("hidden", !pw);
      $("password").required = pw;
      $("loginSubmit").textContent = pw ? "Sign in" : "Sign in with Microsoft";
      if (finishMsLogin()) return;
      if (state.token) showApp(); else showLogin(false);
    }).catch(function () {
      showLogin(false);
      $("loginError").textContent = "Can't reach the admin service.";
    });
  }
  boot();
})();
