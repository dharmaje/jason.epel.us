/* media.js
 *
 * Browser-side reader for ENCRYPTED SIDECAR MEDIA on jason.epel.us.
 *
 * A code-gated page's photos are too big to live inside content.enc, so each one is
 * published beside the page as its own AES-256-GCM blob:
 *
 *     /p/<slug>/media/<id>.jem
 *
 * encrypted under the SAME access code as the page. This script turns one of those
 * blobs into an object URL an <img> can display. Two consumers:
 *
 *   1. A GATED PAGE. build-page-media.py inlines this file into the page's HTML
 *      together with a <script type="application/json" id="page-media"> manifest
 *      mapping real filenames -> blob ids. Because that block sits inside
 *      content.enc, the mapping is readable only after the page is unlocked. The
 *      page calls PageMedia.fromPage(), then .url(name, kind) per photo.
 *   2. THE STANDALONE VIEWER, /v/#p=<slug>/<id>&code=<CODE> — one image, no page,
 *      no prompt. It calls PageMedia.openBlob() directly. This is the "direct
 *      access later" path: hand someone that link and they keep the photo.
 *
 * The original filename, MIME type and dimensions are encrypted INSIDE each blob,
 * so the viewer needs nothing but the URL and the code.
 *
 * WIRE FORMAT — "JEM1", big-endian. KEEP IN SYNC WITH page_media_lib.py:
 *     magic 4 "JEM1" | version 1 | iter u32 | saltLen 1 | salt | ivLen 1 | iv | ct
 *     plaintext = metaLen u16 | metaJSON utf-8 | media bytes
 *
 * WHY A KEY CACHE: PBKDF2 at 250k iterations costs ~200ms. Every blob on a page
 * shares one salt, so the key is derived once and reused for all of them.
 */
(function () {
  "use strict";

  var MAGIC = "JEM1";
  var VERSION = 1;

  // ---- envelope -----------------------------------------------------------
  function parseEnvelope(buf) {
    var v = new DataView(buf);
    var bytes = new Uint8Array(buf);
    if (buf.byteLength < 16) throw new Error("media-corrupt");
    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error("media-corrupt");
    }
    if (bytes[4] !== VERSION) throw new Error("media-version");
    var iter = v.getUint32(5, false);
    var pos = 9;
    var saltLen = bytes[pos]; pos += 1;
    var salt = bytes.subarray(pos, pos + saltLen); pos += saltLen;
    var ivLen = bytes[pos]; pos += 1;
    var iv = bytes.subarray(pos, pos + ivLen); pos += ivLen;
    return { iter: iter, salt: salt, iv: iv, ct: bytes.subarray(pos) };
  }

  // Cache derived keys per code+salt: one PBKDF2 per page, not one per photo.
  var keyCache = {};

  function saltKey(code, salt, iter) {
    var hex = "";
    for (var i = 0; i < salt.length; i++) {
      hex += (salt[i] < 16 ? "0" : "") + salt[i].toString(16);
    }
    return iter + ":" + hex + ":" + code;
  }

  function deriveKey(code, salt, iter) {
    var ck = saltKey(code, salt, iter);
    if (keyCache[ck]) return keyCache[ck];
    keyCache[ck] = crypto.subtle.importKey(
      "raw", new TextEncoder().encode(code), { name: "PBKDF2" }, false, ["deriveKey"]
    ).then(function (baseKey) {
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" },
        baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
      );
    });
    keyCache[ck].catch(function () { delete keyCache[ck]; });
    return keyCache[ck];
  }

  /* Fetch + decrypt one .jem blob.
   * Resolves to { name, type, kind, w, h, bytes, blob, url } where `url` is an
   * object URL ready for an <img src>. Rejects with "media-missing" (bad path),
   * "media-denied" (wrong code / tampered blob), or "media-corrupt". */
  function openBlob(url, code) {
    return fetch(url, { cache: "force-cache" }).then(function (res) {
      if (!res.ok) throw new Error("media-missing");
      return res.arrayBuffer();
    }).then(function (buf) {
      var env = parseEnvelope(buf);
      return deriveKey(code, env.salt, env.iter).then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: env.iv }, key, env.ct);
      }).catch(function () { throw new Error("media-denied"); });
    }).then(function (plain) {
      var view = new DataView(plain);
      var metaLen = view.getUint16(0, false);
      var meta = {};
      try {
        meta = JSON.parse(new TextDecoder().decode(new Uint8Array(plain, 2, metaLen)));
      } catch (e) { throw new Error("media-corrupt"); }
      var body = new Uint8Array(plain, 2 + metaLen);
      var type = meta.type || "application/octet-stream";
      var blob = new Blob([body], { type: type });
      return {
        name: meta.name || "", type: type, kind: meta.kind || "",
        w: meta.w || null, h: meta.h || null,
        bytes: body.byteLength, blob: blob, url: URL.createObjectURL(blob)
      };
    });
  }

  // ---- the page-bound helper ---------------------------------------------
  /* One instance per page: the manifest from inside content.enc plus the code the
   * visitor already entered. Decrypted object URLs are memoised, so revisiting a
   * photo (reopening the lightbox, scrolling a thumb back into view) is free. */
  function Media(manifest, code) {
    this.manifest = manifest || { items: {} };
    this.code = code || "";
    this.items = this.manifest.items || {};
    this._blobs = {};   // "kind:name" -> Promise<{...}>
    this._index = {};   // lookup aliases -> canonical manifest key
    var self = this;
    Object.keys(this.items).forEach(function (name) {
      self._index[name.toLowerCase()] = name;
      var bare = name.replace(/^.*\//, "");
      self._index[bare.toLowerCase()] = name;
      self._index[bare.replace(/\.[^.]+$/, "").toLowerCase()] = name;
    });
  }

  /* Forgiving lookup: the page may cite "photos/foo.jpeg", "../photos/foo.jpeg",
   * "foo.jpeg" or (after a re-export) "foo.jpg" for the same original. */
  Media.prototype.key = function (name) {
    if (!name) return null;
    if (this.items[name]) return name;
    var n = String(name).toLowerCase();
    return this._index[n]
      || this._index[n.replace(/^.*\//, "")]
      || this._index[n.replace(/^.*\//, "").replace(/\.[^.]+$/, "")]
      || null;
  };

  Media.prototype.has = function (name) { return !!this.key(name); };

  Media.prototype.item = function (name) {
    var k = this.key(name);
    return k ? this.items[k] : null;
  };

  Media.prototype.blobId = function (name, kind) {
    var it = this.item(name);
    if (!it) return null;
    return it[kind] || it.full || null;
  };

  /* Page-relative path of a blob — resolves correctly because gate.js renders the
   * decrypted page at its own URL (/p/<slug>/), so media/… is a real sibling. */
  Media.prototype.path = function (name, kind) {
    var id = this.blobId(name, kind);
    if (!id) return null;
    return (this.manifest.dir || "media/") + id + (this.manifest.ext || ".jem");
  };

  /* Promise<objectURL> for one photo. `kind` is "thumb" or "full". */
  Media.prototype.url = function (name, kind) {
    var k = this.key(name);
    if (!k) return Promise.reject(new Error("media-unknown"));
    var id = this.blobId(k, kind);
    var slot = kind + ":" + k;
    if (!this._blobs[slot]) {
      this._blobs[slot] = openBlob(this.path(k, kind), this.code);
      var self = this;
      this._blobs[slot].catch(function () { delete self._blobs[slot]; });
    }
    return this._blobs[slot].then(function (r) { return r.url; });
  };

  /* Everything about a decrypted photo (name, type, size, object URL). */
  Media.prototype.open = function (name, kind) {
    var k = this.key(name);
    if (!k) return Promise.reject(new Error("media-unknown"));
    this.url(k, kind);                       // seed/reuse the cache
    return this._blobs[kind + ":" + k];
  };

  /* The standalone, gate-free link to the full-size original of one photo — what
   * the page's "copy link" button hands out. Includes the code, so the recipient
   * needs nothing else. Returns "" when the photo isn't in the manifest. */
  Media.prototype.link = function (name, base) {
    var id = this.blobId(name, "full");
    if (!id || !this.manifest.slug) return "";
    var origin = base || (location.origin || "");
    return origin + (this.manifest.viewer || "/v/") + "#p="
      + encodeURIComponent(this.manifest.slug) + "/" + id
      + "&code=" + encodeURIComponent(this.code);
  };

  // ---- boot helpers -------------------------------------------------------
  /* The access code the visitor already supplied. gate.js hands it over on the
   * window (document.write keeps the same global object) and also caches it in
   * sessionStorage; either is enough, and the second survives a refresh. */
  function pageCode() {
    if (window.__GATE_CODE__) return window.__GATE_CODE__;
    try {
      return sessionStorage.getItem("jepel-code:" + location.pathname) || "";
    } catch (e) { return ""; }
  }

  /* Bind to the manifest injected inside this page. Returns null when the page has
   * no media block or no code — callers fall back to plain URLs (which is what
   * happens when the source HTML is opened straight from the vault). */
  function fromPage() {
    var el = document.getElementById("page-media");
    if (!el) return null;
    var manifest;
    try { manifest = JSON.parse(el.textContent); } catch (e) { return null; }
    if (!manifest || !manifest.items) return null;
    var code = pageCode();
    if (!code) return null;
    if (!window.crypto || !crypto.subtle) return null;
    return new Media(manifest, code);
  }

  window.PageMedia = {
    VERSION: VERSION,
    parseEnvelope: parseEnvelope,
    deriveKey: deriveKey,
    openBlob: openBlob,
    create: function (manifest, code) { return new Media(manifest, code); },
    fromPage: fromPage,
    pageCode: pageCode
  };
})();
