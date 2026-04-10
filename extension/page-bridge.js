// Page bridge — runs in MAIN world, accesses App Inventor globals directly
// Receives tool calls from content.js via postMessage, executes, responds

(function() {
  'use strict';

  /** Bump with extension/manifest.json — visible in console and get_project_info.mcpBridgeBuild */
  const PAGE_BRIDGE_BUILD_ID = '0.1.18';

  // Marker on the document so the content script can detect an existing bridge (script tag is removed after load).
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-aimcp-page-bridge', '1');
    document.documentElement.setAttribute('data-aimcp-bridge-version', PAGE_BRIDGE_BUILD_ID);
  }

  console.log('[MCP Bridge] page-bridge build', PAGE_BRIDGE_BUILD_ID);

  const BRIDGE_PREFIX = 'appinventor-mcp-';

  // --- Session parameter capture ---
  let capturedSessionUuid = null;
  let capturedFilePath = null;
  let capturedGwtHash = null;

  // Extract GWT permutation hash from page scripts (for X-GWT-Permutation header)
  let gwtPermutationHash = null;
  function extractGwtPermutation() {
    if (gwtPermutationHash) return gwtPermutationHash;
    const scripts = document.querySelectorAll('script[src*=".cache.js"]');
    for (const s of scripts) {
      const match = s.src.match(/([A-Fa-f0-9]{32,})\.cache\.js/);
      if (match) {
        gwtPermutationHash = match[1];
        return gwtPermutationHash;
      }
    }
    return null;
  }

  // Also try extracting from GWT's nocache.js selection
  function extractGwtHash() {
    if (capturedGwtHash) return capturedGwtHash;
    // Will be captured from intercepted save2 body
    return null;
  }

  /** Last observed GWT-RPC body for {@code ProjectService#load} — used to replay shape without {@code Ode} on window. */
  let lastObservedLoadRpcBody = null;

  /** Last {@code save2} body — reliably contains {@code src/appinventor/.../*.scm} and often the project id. */
  let lastObservedSave2RpcBody = null;

  /**
   * Extract {@code src/appinventor/.../Screen.scm} from a GWT-RPC body. MIT often embeds JSON-escaped
   * slashes ({@code src\/appinventor\/...}) so a naive {@code src/appinventor/...} regex misses.
   */
  function extractScmFilePathFromRpcBody(body) {
    if (!body || typeof body !== 'string') return null;
    const pools = [];
    pools.push(body.replace(/\\\//g, '/'));
    try {
      pools.push(decodeURIComponent(body).replace(/\\\//g, '/'));
    } catch (e) {
      /* ignore */
    }
    const pipeParts = body.split('|');
    for (let p = 0; p < pipeParts.length; p++) {
      pools.push(pipeParts[p].replace(/\\\//g, '/'));
    }
    for (let i = 0; i < pools.length; i++) {
      const normalized = pools[i];
      if (!normalized) continue;
      let pos = 0;
      while (pos < normalized.length) {
        const start = normalized.indexOf('src/appinventor/', pos);
        if (start < 0) break;
        const rest = normalized.slice(start);
        const scmIdx = rest.indexOf('.scm');
        if (scmIdx < 0) {
          pos = start + 16;
          continue;
        }
        let seg = normalized.slice(start, start + scmIdx + 4);
        const cut = seg.search(/[\s|"'\t\r\n|]/);
        if (cut > 0) seg = seg.slice(0, cut);
        if (/^src\/appinventor\/.+\.scm$/.test(seg)) {
          return seg;
        }
        pos = start + 4;
      }
    }
    return null;
  }

  // Intercept XHR to capture all params from save2 calls
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (typeof body === 'string') {
      if (
        body.indexOf('com.google.appinventor.shared.rpc.project.ProjectService') !== -1 &&
        body.indexOf('|load|') !== -1
      ) {
        lastObservedLoadRpcBody = body;
        try {
          window.__AIMCP_LAST_LOAD_RPC = body;
        } catch (e) {
          /* ignore */
        }
      }
    }
    if (typeof body === 'string' && body.includes('save2')) {
      lastObservedSave2RpcBody = body;
      try {
        window.__AIMCP_LAST_SAVE2_RPC = body;
      } catch (e) {
        /* ignore */
      }
      const fields = body.split('|');
      if (fields.length > 4) capturedGwtHash = fields[4];
      const uuidMatch = body.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (uuidMatch) capturedSessionUuid = uuidMatch[1];
      const pathExtracted = extractScmFilePathFromRpcBody(body);
      if (pathExtracted) capturedFilePath = pathExtracted;
      const base36Match = body.match(/\|8\|([A-Za-z0-9]+)\|9\|/);
      if (base36Match) capturedBase36 = base36Match[1];
      // Capture SCM JSON and save full body as template
      const scmMatch = body.match(/#\\!\n\$JSON\n([\s\S]*?)\n\\!#/);
      if (scmMatch) {
        try {
          capturedScmJson = JSON.parse(scmMatch[1]);
          // Save the full body, replacing only the JSON portion with a placeholder
          capturedRpcTemplate = body.replace(scmMatch[1], '___SCM_PLACEHOLDER___');
        } catch(e) {}
      }
      console.log('[MCP Bridge] Intercepted save2 params:', {
        gwtHash: capturedGwtHash, sessionUuid: capturedSessionUuid,
        filePath: capturedFilePath, base36: capturedBase36,
        hasScm: !!capturedScmJson, hasTemplate: !!capturedRpcTemplate
      });
      // Write to cache via content script
      window.postMessage({
        type: BRIDGE_PREFIX + 'cache-write',
        data: {
          sessionUuid: capturedSessionUuid,
          gwtHash: capturedGwtHash,
          filePath: capturedFilePath,
          base36: capturedBase36,
          scmJson: capturedScmJson,
          rpcTemplate: capturedRpcTemplate,
          timestamp: Date.now()
        }
      }, '*');
    }
    return origSend.apply(this, arguments);
  };

  // Direct extraction fallbacks — don't rely on intercepting save2
  function extractSessionUuid() {
    if (capturedSessionUuid) return capturedSessionUuid;
    // Try extracting from GWT's internal state via cookie or meta
    const cookies = document.cookie;
    const match = cookies.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (match) { capturedSessionUuid = match[1]; return match[1]; }
    // Try performance entries for past save2 XHRs
    const entries = performance.getEntriesByType('resource');
    for (const e of entries) {
      if (e.name.includes('/ode/') && e.initiatorType === 'xmlhttprequest') {
        // We found an ODE request — session UUID was in the body, but we can't read it from perf entries
        // Fall through to force-trigger approach
      }
    }
    return null;
  }

  function extractFilePath(screenName) {
    if (capturedFilePath) return capturedFilePath;
    // Construct file path from known patterns
    // Format: src/appinventor/ai_<user>/<projectName>/Screen1.scm
    try {
      const projectName = typeof BlocklyPanel_getProjectName === 'function' ? BlocklyPanel_getProjectName() : null;
      if (!projectName) return null;
      // Try to find user email from page
      const userEl = document.querySelector('.ode-TopPanelUserEmail') ||
                     document.querySelector('[class*="UserEmail"]') ||
                     document.querySelector('.gwt-Label[title*="@"]');
      let userPrefix = null;
      if (userEl) {
        const email = userEl.textContent || userEl.title || '';
        userPrefix = 'ai_' + email.replace(/@/g, '_').replace(/\./g, '_');
      }
      // Also try from the page URL or GWT state
      if (!userPrefix) {
        userPrefix = scrapeUserPrefixFromPage();
      }
      if (userPrefix) {
        capturedFilePath = `src/appinventor/${userPrefix}/${projectName}/${screenName || 'Screen1'}.scm`;
        return capturedFilePath;
      }
    } catch(e) {}
    return null;
  }

  /** Find {@code ai_*} user folder when TopBar / innerHTML scan misses (e.g. Blocks-only view). */
  function scrapeUserPrefixFromPage() {
    const re = /src\/appinventor\/(ai_[a-zA-Z0-9_]+)\//;
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (!name) continue;
        const m = name.match(re);
        if (m) return m[1];
      }
    } catch (e) {
      /* ignore */
    }
    const blobs = [];
    try {
      if (document.documentElement) blobs.push(document.documentElement.outerHTML);
    } catch (e) {
      /* ignore */
    }
    try {
      if (document.body) {
        blobs.push(document.body.outerHTML, document.body.innerHTML);
      }
    } catch (e) {
      /* ignore */
    }
    for (let b = 0; b < blobs.length; b++) {
      const m = blobs[b] && blobs[b].match(re);
      if (m) return m[1];
    }
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (let i = 0; i < scripts.length; i++) {
        const t = scripts[i].textContent || '';
        const m = t.match(re);
        if (m) return m[1];
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const links = document.querySelectorAll('a[href*="appinventor"],[href*="src/appinventor"]');
      for (let i = 0; i < links.length; i++) {
        const h = links[i].getAttribute('href') || '';
        const m = h.match(re);
        if (m) return m[1];
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Captured SCM content, base36, and full RPC body template from save2 request
  let capturedScmJson = null;
  let capturedBase36 = null;
  let capturedRpcTemplate = null; // Full RPC body with SCM placeholder

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Derive path from any captured load/save2 RPC (works when DOM has no .scm snippets yet). */
  function scmPathFromObservedRpcBodies(screenName) {
    const sn = screenName || 'Screen1';
    const bodies = [];
    if (lastObservedLoadRpcBody) bodies.push(lastObservedLoadRpcBody);
    if (lastObservedSave2RpcBody) bodies.push(lastObservedSave2RpcBody);
    try {
      if (typeof window.__AIMCP_LAST_LOAD_RPC === 'string') bodies.push(window.__AIMCP_LAST_LOAD_RPC);
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof window.__AIMCP_LAST_SAVE2_RPC === 'string') bodies.push(window.__AIMCP_LAST_SAVE2_RPC);
    } catch (e) {
      /* ignore */
    }
    for (let b = 0; b < bodies.length; b++) {
      const body = bodies[b];
      if (!body) continue;
      const pm = extractScmFilePathFromRpcBody(body);
      if (pm) {
        return pm.replace(/\/[^/]+\.scm$/, '/' + sn + '.scm');
      }
    }
    return null;
  }

  /** Resolve src/appinventor/.../Project/Screen.scm — used when save2 has not populated capturedFilePath yet. */
  function resolveScmFilePath(screenName) {
    const sn = screenName || 'Screen1';
    if (capturedFilePath) {
      return capturedFilePath.replace(/\/[^/]+\.scm$/, '/' + sn + '.scm');
    }
    const built = extractFilePath(sn);
    if (built) return built;
    const fromRpc = scmPathFromObservedRpcBodies(sn);
    if (fromRpc) return fromRpc;
    const projectName =
      typeof BlocklyPanel_getProjectName === 'function' ? BlocklyPanel_getProjectName() : null;
    let html = '';
    try {
      html = document.documentElement ? document.documentElement.innerHTML : '';
      if (document.body) html += document.body.innerHTML;
    } catch (e) {
      /* ignore */
    }
    if (projectName) {
      const m = html.match(/src\/appinventor\/(ai_[^/]+)\//);
      if (m) {
        return 'src/appinventor/' + m[1] + '/' + projectName + '/' + sn + '.scm';
      }
    }
    const prefix = scrapeUserPrefixFromPage();
    if (prefix && projectName) {
      return 'src/appinventor/' + prefix + '/' + projectName + '/' + sn + '.scm';
    }
    const guessed = guessScmPathFromPageSnippets(sn, projectName);
    if (guessed) return guessed;
    return null;
  }

  /** Last resort: find any full .scm path substring in the live DOM (Blocks editor embeds paths in JS/state). */
  function guessScmPathFromPageSnippets(screenName, projectName) {
    const sn = screenName || 'Screen1';
    let blob = collectResourceAndScriptBlob();
    try {
      if (document.documentElement) blob += document.documentElement.outerHTML;
    } catch (e) {
      /* ignore */
    }
    try {
      if (document.body) blob += document.body.innerHTML;
    } catch (e) {
      /* ignore */
    }
    if (!blob) return null;
    const re = /src\/appinventor\/(ai_[a-zA-Z0-9_]+)\/([^/"'\s|]+)\/([^/"'\s|]+)\.scm/g;
    let m;
    while ((m = re.exec(blob)) !== null) {
      if (!projectName || m[2] === projectName) {
        return 'src/appinventor/' + m[1] + '/' + m[2] + '/' + sn + '.scm';
      }
    }
    return null;
  }

  /** Collect URLs that may embed {@code src/appinventor/.../*.scm} (XHR, scripts, percent-encoded). */
  function collectResourceAndScriptBlob() {
    let extra = '';
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (!name) continue;
        if (name.indexOf('appinventor') >= 0 || name.indexOf('.scm') >= 0 || name.indexOf('%') >= 0) {
          extra += name + '\n';
          if (name.indexOf('%') >= 0) {
            try {
              const dec = decodeURIComponent(name);
              if (dec !== name) extra += dec + '\n';
            } catch (e) {
              /* ignore */
            }
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const scripts = document.querySelectorAll('script[src]');
      for (let i = 0; i < scripts.length; i++) {
        extra += (scripts[i].src || '') + '\n';
      }
    } catch (e) {
      /* ignore */
    }
    return extra;
  }

  /**
   * Find project id in a GWT-RPC body: locate the {@code src/appinventor/.../*.scm} field, then the
   * nearest preceding numeric pipe token (MIT ids are usually 6+ digits).
   */
  function parseProjectIdFromPipeRpcBody(sample) {
    if (!sample || typeof sample !== 'string') return null;
    const parts = sample.split('|');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].replace(/\\\//g, '/');
      if (p && p.indexOf('src/appinventor') === 0 && p.indexOf('.scm') > 0) {
        for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
          const c = parts[j];
          if (c && /^[0-9]{5,12}$/.test(c)) {
            const n = parseInt(c, 10);
            if (n >= 100000) return c;
          }
        }
        for (let j = i + 1; j < parts.length && j <= i + 8; j++) {
          const c = parts[j];
          if (c && /^[0-9]{5,12}$/.test(c)) {
            const n = parseInt(c, 10);
            if (n >= 100000) return c;
          }
        }
      }
    }
    return null;
  }

  /** save2 bodies use {@code |8|<base36>|9|} for the numeric project id (same as {@code parseInt(id).toString(36)}). */
  function decodeProjectIdFromBase36(b36) {
    if (!b36 || typeof b36 !== 'string') return null;
    const t = b36.trim();
    if (!/^[A-Za-z0-9]+$/.test(t)) return null;
    const n = parseInt(t, 36);
    if (!Number.isFinite(n) || n < 1) return null;
    return String(n);
  }

  /** Pull base36 token from captured save2/load RPC strings (even before globals are copied). */
  function extractBase36FromRpcBodies() {
    const bodies = [lastObservedSave2RpcBody, lastObservedLoadRpcBody];
    try {
      bodies.push(window.__AIMCP_LAST_SAVE2_RPC, window.__AIMCP_LAST_LOAD_RPC);
    } catch (e) {
      /* ignore */
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || typeof b !== 'string') continue;
      const m = b.match(/\|8\|([A-Za-z0-9]+)\|9\|/);
      if (m) return m[1];
    }
    return null;
  }

  /** Prefer {@code HTML5DragDrop_getOpenProjectId}, else last captured {@code ProjectService#load} body or DOM hints. */
  function resolveOpenProjectId() {
    if (typeof HTML5DragDrop_getOpenProjectId === 'function') {
      try {
        const id = HTML5DragDrop_getOpenProjectId();
        if (id != null && String(id).length > 0) return String(id);
      } catch (e) {
        /* ignore */
      }
    }
    const b36Token = capturedBase36 || extractBase36FromRpcBodies();
    const fromB36 = decodeProjectIdFromBase36(b36Token);
    if (fromB36) return fromB36;
    try {
      const href = typeof location !== 'undefined' ? location.href : '';
      const qm = href.match(/(?:[?&#])(?:project|projectId|pid)=([0-9]{5,12})\b/i);
      if (qm) return qm[1];
    } catch (e) {
      /* ignore */
    }
    let sample = lastObservedLoadRpcBody;
    try {
      if (!sample && typeof window.__AIMCP_LAST_LOAD_RPC === 'string') {
        sample = window.__AIMCP_LAST_LOAD_RPC;
      }
    } catch (e) {
      /* ignore */
    }
    let fromRpc = parseProjectIdFromPipeRpcBody(sample);
    if (fromRpc) return fromRpc;
    let sampleSave = lastObservedSave2RpcBody;
    try {
      if (!sampleSave && typeof window.__AIMCP_LAST_SAVE2_RPC === 'string') {
        sampleSave = window.__AIMCP_LAST_SAVE2_RPC;
      }
    } catch (e) {
      /* ignore */
    }
    fromRpc = parseProjectIdFromPipeRpcBody(sampleSave);
    if (fromRpc) return fromRpc;
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const m = html.match(/(?:projectId|openProjectId|currentProjectId)\s*[:=]\s*["']?([0-9]{5,12})\b/);
      if (m) return m[1];
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /** Best-effort switch from Blocks to Designer so save2 / GWT hooks work. */
  function trySwitchToDesignerView() {
    try {
      const tabs = document.querySelectorAll(
        '[role="tab"], .gwt-TabLayoutPanelTab, .tab-top, .tabLayoutPanelTab, [class*="TabLayoutPanelTab"]'
      );
      for (const el of tabs) {
        const t = (el.textContent || '').trim();
        if (t === 'Designer' || /^Designer$/i.test(t)) {
          el.click();
          return true;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function screenFromCapturedPath() {
    if (!capturedFilePath) return null;
    const m = capturedFilePath.match(/\/([^/]+)\.scm$/);
    return m ? m[1] : null;
  }

  function projectServiceFromOdeLike(ctor) {
    try {
      if (!ctor || typeof ctor.getInstance !== 'function') return null;
      const inst = ctor.getInstance();
      if (!inst || typeof inst.getProjectService !== 'function') return null;
      const ps = inst.getProjectService();
      if (ps && typeof ps.load === 'function') return ps;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * GWT exposes {@code Ode.getInstance().getProjectService()} — same {@code ProjectService#load}
   * the IDE uses to read .scm from the server (no Designer / save2 nudge required).
   * The minified app may hide {@code Ode} on {@code window} or put it in an iframe — search broadly.
   */
  function findOdeProjectService() {
    const seen = new Set();
    const candidates = [];

    function addWin(w) {
      if (!w || seen.has(w)) return;
      try {
        if (typeof w !== 'object') return;
      } catch (e) {
        return;
      }
      seen.add(w);
      candidates.push(w);
    }

    addWin(window);
    try {
      addWin(window.parent);
    } catch (e) {
      /* cross-origin */
    }
    try {
      addWin(window.opener);
    } catch (e) {
      /* cross-origin */
    }
    try {
      addWin(window.top);
    } catch (e) {
      /* cross-origin */
    }

    function collectIframes(doc, depth) {
      if (depth > 3 || !doc) return;
      let list;
      try {
        list = doc.querySelectorAll('iframe');
      } catch (e) {
        return;
      }
      for (let i = 0; i < list.length; i++) {
        try {
          const cw = list[i].contentWindow;
          addWin(cw);
          if (cw && cw.document) collectIframes(cw.document, depth + 1);
        } catch (e) {
          /* cross-origin */
        }
      }
    }
    collectIframes(document, 0);

    function scanGlobal(r) {
      try {
        if (r.Ode) {
          const ps = projectServiceFromOdeLike(r.Ode);
          if (ps) return ps;
        }
      } catch (e) {
        /* ignore */
      }
      let keys;
      try {
        keys = Object.getOwnPropertyNames(r);
      } catch (e) {
        return null;
      }
      const max = Math.min(keys.length, 800);
      for (let i = 0; i < max; i++) {
        try {
          const v = r[keys[i]];
          const ps = projectServiceFromOdeLike(v);
          if (ps) return ps;
        } catch (e) {
          /* ignore */
        }
      }
      return null;
    }

    for (let j = 0; j < candidates.length; j++) {
      const ps = scanGlobal(candidates[j]);
      if (ps) return ps;
    }
    return null;
  }

  function parseScmFileTextToTree(raw) {
    if (raw == null) return null;
    const s = typeof raw === 'string' ? raw : String(raw);
    const m = s.match(/#\s*!\\?\s*\n\s*\$JSON\s*\n([\s\S]*?)\n\s*!\\?#/);
    if (m) {
      try {
        return JSON.parse(m[1].trim());
      } catch (e) {
        console.log('[MCP Bridge] parseScmFileTextToTree:', e.message);
      }
    }
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function loadSourceViaProjectService(projectIdStr, fileId) {
    return new Promise((resolve, reject) => {
      const ps = findOdeProjectService();
      if (!ps) {
        reject(new Error('ProjectService not available'));
        return;
      }
      const pid = parseInt(String(projectIdStr), 10);
      if (Number.isNaN(pid) || pid <= 0) {
        reject(new Error('Invalid project id'));
        return;
      }
      const cb = {
        onSuccess: function (result) {
          resolve(result);
        },
        onFailure: function (th) {
          reject(th || new Error('ProjectService.load failed'));
        }
      };
      try {
        ps.load(pid, fileId, cb);
      } catch (e) {
        reject(e);
      }
    });
  }

  function postGwtProjectsSync(rpcBody) {
    const permHash = extractGwtPermutation();
    if (!permHash || !rpcBody) return null;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', window.location.origin + '/ode/projects', false);
      xhr.setRequestHeader('Content-Type', 'text/x-gwt-rpc; charset=UTF-8');
      xhr.setRequestHeader('X-GWT-Module-Base', window.location.origin + '/ode/');
      xhr.setRequestHeader('X-GWT-Permutation', permHash);
      xhr.send(rpcBody);
      if (xhr.status !== 200) return null;
      return xhr.responseText || '';
    } catch (e) {
      console.log('[MCP Bridge] postGwtProjectsSync:', e.message);
      return null;
    }
  }

  function extractScmTextFromGwtLoadResponse(resp) {
    if (!resp || typeof resp !== 'string') return null;
    if (resp.indexOf('//EX') === 0) return null;
    const i = resp.indexOf('#!');
    if (i >= 0) {
      let s = resp.substring(i);
      s = s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return s;
    }
    return null;
  }

  /**
   * When {@code Ode} is not on window, replay a previously observed {@code load} RPC (captured from
   * normal IDE traffic) or try a few synthetic GWT-RPC bodies. Same cookies/session as the tab.
   */
  function loadSourceViaRecordedOrSyntheticRpc(projectIdStr, fileId) {
    const pid = String(projectIdStr);
    const baseUrl = window.location.origin + '/ode/';
    const permHash = extractGwtPermutation();
    if (!permHash) return null;

    let sample = lastObservedLoadRpcBody;
    try {
      if (!sample && typeof window.__AIMCP_LAST_LOAD_RPC === 'string') {
        sample = window.__AIMCP_LAST_LOAD_RPC;
      }
    } catch (e) {
      /* ignore */
    }
    if (sample) {
      const oldPathInSample = extractScmFilePathFromRpcBody(sample);
      let body = sample;
      if (oldPathInSample) {
        body = body.split(oldPathInSample).join(fileId);
        const esc = oldPathInSample.replace(/\//g, '\\/');
        if (esc !== oldPathInSample && body.indexOf(esc) >= 0) {
          body = body.split(esc).join(fileId.replace(/\//g, '\\/'));
        }
      } else {
        body = sample.replace(/src\/appinventor\/[^|]+\.scm/g, fileId);
      }
      const loadIdx = body.indexOf('|load|');
      if (loadIdx >= 0) {
        const after = body.substring(loadIdx);
        const mid = after.match(/\|(\d{5,12})\|/);
        if (mid && mid[1] && mid[1] !== pid) {
          body = body.replace(new RegExp('\\|' + mid[1] + '\\|', 'g'), '|' + pid + '|');
        }
      }
      const r = postGwtProjectsSync(body);
      const text = extractScmTextFromGwtLoadResponse(r);
      if (text) return text;
    }

    const variants = [
      ['7|0|8', baseUrl, permHash, 'com.google.appinventor.shared.rpc.project.ProjectService', 'load', 'J', 'java.lang.String/2004016611', pid, fileId].join('|') + '|',
      ['7|0|8', baseUrl, permHash, 'com.google.appinventor.shared.rpc.project.ProjectService', 'load', 'java.lang.Long/1763741826', 'java.lang.String/2004016611', pid, fileId].join('|') + '|',
      ['7|0|8', baseUrl, permHash, 'com.google.appinventor.shared.rpc.project.ProjectService', 'load', 'java.lang.Long/4220379629', 'java.lang.String/2004016611', pid, fileId].join('|') + '|',
      ['7|0|9', baseUrl, permHash, 'com.google.appinventor.shared.rpc.project.ProjectService', 'load', 'java.lang.Long/1763741826', 'java.lang.String/2004016611', pid, fileId].join('|') + '|'
    ];
    for (let v = 0; v < variants.length; v++) {
      const r = postGwtProjectsSync(variants[v]);
      const text = extractScmTextFromGwtLoadResponse(r);
      if (text) return text;
    }
    return null;
  }

  // Force a save2 by making a trivial property change, then capture ALL params from XHR
  function forceSave2Capture() {
    return new Promise((resolve) => {
      const origSend2 = XMLHttpRequest.prototype.send;
      let resolved = false;
      XMLHttpRequest.prototype.send = function(body) {
        if (!resolved && typeof body === 'string' && body.includes('save2')) {
          // Parse the pipe-delimited fields
          const fields = body.split('|');
          // Field layout: 7|0|10|baseUrl|gwtHash|service|save2|stringType|J|Z|uuid|path|scmContent|params...
          // GWT hash is field index 4 (0-indexed: 3)
          if (fields.length > 4) capturedGwtHash = fields[4];

          const uuidMatch = body.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          if (uuidMatch) capturedSessionUuid = uuidMatch[1];
          const pathEx = extractScmFilePathFromRpcBody(body);
          if (pathEx) capturedFilePath = pathEx;

          // Capture base36 project ID from the parameter section at the end
          // Pattern: |8|{base36}|9|0|10|
          const base36Match = body.match(/\|8\|([A-Za-z0-9]+)\|9\|/);
          if (base36Match) capturedBase36 = base36Match[1];

          // Capture the current SCM JSON from the body
          const scmMatch = body.match(/#\\!\n\$JSON\n([\s\S]*?)\n\\!#/);
          if (scmMatch) {
            try { capturedScmJson = JSON.parse(scmMatch[1]); } catch(e) {
              console.log('[MCP Bridge] SCM parse error:', e.message);
            }
          }
          console.log('[MCP Bridge] Captured all params:', {
            gwtHash: capturedGwtHash,
            sessionUuid: capturedSessionUuid,
            filePath: capturedFilePath,
            base36: capturedBase36,
            hasScm: !!capturedScmJson
          });
          resolved = true;
          XMLHttpRequest.prototype.send = origSend2;
          resolve(true);
        }
        return origSend2.apply(this, arguments);
      };
      function nudgeForceCapture() {
        if (typeof BlocklyPanel_setComponentProperty !== 'function') return false;
        const screen =
          typeof BlocklyPanel_getCurrentScreen === 'function' ? BlocklyPanel_getCurrentScreen() : 'Screen1';
        const title =
          typeof BlocklyPanel_getComponentInstancePropertyValue === 'function'
            ? BlocklyPanel_getComponentInstancePropertyValue(screen, screen, 'Title')
            : 'Screen1';
        BlocklyPanel_setComponentProperty(screen, screen, 'Title', title + ' ', 'Title');
        setTimeout(() => {
          BlocklyPanel_setComponentProperty(screen, screen, 'Title', title, 'Title');
        }, 200);
        return true;
      }
      if (!nudgeForceCapture()) {
        trySwitchToDesignerView();
        setTimeout(() => {
          if (!resolved) nudgeForceCapture();
        }, 450);
      }
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          XMLHttpRequest.prototype.send = origSend2;
          resolve(false);
        }
      }, 6000);
    });
  }

  /**
   * Load .scm JSON via GWT {@code ProjectService#load} or synthetic/replayed RPC.
   * @returns {Promise<boolean>} true if {@code capturedScmJson} was set
   */
  async function tryLoadScmTreeFromServer(fileId, projectId) {
    if (!fileId || !projectId) return false;
    try {
      const raw = await loadSourceViaProjectService(String(projectId), fileId);
      const text = typeof raw === 'string' ? raw : raw != null ? String(raw) : '';
      const tree = parseScmFileTextToTree(text);
      if (tree) {
        capturedScmJson = tree;
        capturedFilePath = fileId;
        return true;
      }
    } catch (e) {
      console.log('[MCP Bridge] ProjectService.load:', e && e.message ? e.message : e);
    }
    const viaRpc = loadSourceViaRecordedOrSyntheticRpc(String(projectId), fileId);
    if (viaRpc) {
      const tree2 = parseScmFileTextToTree(viaRpc);
      if (tree2) {
        capturedScmJson = tree2;
        capturedFilePath = fileId;
        return true;
      }
    }
    return false;
  }

  /** One Designer + save2 nudge pass (Blocks-only needs time for APIs to attach). */
  async function runDesignerSave2FallbackPass(screenName) {
    trySwitchToDesignerView();
    await delay(280);
    if (typeof BlocklyPanel_switchScreen === 'function') {
      try {
        BlocklyPanel_switchScreen(screenName);
      } catch (e) {
        console.log('[MCP Bridge] get_component_tree switchScreen:', e);
      }
      await delay(280);
    }
    await getCurrentScm(5000);
    if (!capturedScmJson) {
      await forceSave2Capture();
    }
  }

  // --- Tool implementations ---

  function handle_get_project_info() {
    const blocksOpen = typeof Blockly !== 'undefined' && Blockly.getMainWorkspace() !== null;
    const designerApis =
      typeof BlocklyPanel_setComponentProperty === 'function' &&
      typeof BlocklyPanel_getCurrentScreen === 'function';
    return {
      success: true,
      mcpBridgeBuild: PAGE_BRIDGE_BUILD_ID,
      projectId: resolveOpenProjectId(),
      projectName: typeof BlocklyPanel_getProjectName === 'function' ? BlocklyPanel_getProjectName() : null,
      isEditorOpen: document.querySelector('.ode-Box') !== null,
      isBlocksEditorOpen: blocksOpen,
      designerApisAvailable: designerApis,
      /** Prefer Designer (or at least designer APIs) for add_components / SCM tools when this is false. */
      scmToolsRecommended: designerApis,
      /** True when GWT {@code Ode.getInstance().getProjectService()} is visible — enables server-side .scm reads without Designer. */
      projectServiceLoadAvailable: !!findOdeProjectService(),
      /** True after the IDE has issued at least one {@code ProjectService#load} XHR (replay works for other screens). */
      loadRpcSampleCaptured: (function () {
        if (lastObservedLoadRpcBody) return true;
        try {
          return typeof window.__AIMCP_LAST_LOAD_RPC === 'string' && window.__AIMCP_LAST_LOAD_RPC.length > 0;
        } catch (e) {
          return false;
        }
      })(),
      /** True after at least one {@code save2} XHR in this tab (path + project id often recoverable). */
      save2RpcSampleCaptured: (function () {
        if (lastObservedSave2RpcBody) return true;
        try {
          return typeof window.__AIMCP_LAST_SAVE2_RPC === 'string' && window.__AIMCP_LAST_SAVE2_RPC.length > 0;
        } catch (e) {
          return false;
        }
      })(),
      currentScreen: typeof BlocklyPanel_getCurrentScreen === 'function' ? BlocklyPanel_getCurrentScreen() : 'Screen1'
    };
  }

  async function handle_get_component_tree(params) {
    const screenName = params.screenName || 'Screen1';

    if (capturedScmJson && screenFromCapturedPath() === screenName) {
      return { success: true, screenName, tree: capturedScmJson };
    }

    let fileId = resolveScmFilePath(screenName);
    let projectId = resolveOpenProjectId();

    if (fileId && projectId && (await tryLoadScmTreeFromServer(fileId, projectId))) {
      return { success: true, screenName, tree: capturedScmJson };
    }

    await runDesignerSave2FallbackPass(screenName);

    fileId = resolveScmFilePath(screenName);
    projectId = resolveOpenProjectId();
    if (fileId && projectId && (await tryLoadScmTreeFromServer(fileId, projectId))) {
      return { success: true, screenName, tree: capturedScmJson };
    }

    if (capturedScmJson) {
      const cap = screenFromCapturedPath();
      const warning =
        cap && cap !== screenName
          ? `Tree is for screen "${cap}"; you requested "${screenName}". Select that screen in the Designer preview if wrong.`
          : undefined;
      return { success: true, screenName, tree: capturedScmJson, warning };
    }

    const havePath = !!resolveScmFilePath(screenName);
    const haveId = !!resolveOpenProjectId();
    let detail =
      'Could not read the component tree. Open the Designer tab, wait for the project to finish loading, then retry.';
    if (!havePath && !haveId) {
      detail =
        'Could not resolve the project file path or project id (no save2/load captured yet). Click the Designer tab once, or switch screens, then retry.';
    } else if (!havePath) {
      detail =
        'Could not resolve the .scm file path. Open the Designer tab or switch screens so the IDE saves once, then retry.';
    } else if (!haveId) {
      detail =
        'Could not resolve the project id. Open the Designer tab briefly, then retry.';
    }

    return {
      success: false,
      error: detail
    };
  }

  // Generate a UUID v4
  function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // Read current SCM from GWT's internal state by triggering a save and intercepting
  /** @param {number} [timeoutMs] default 10s; use ~4.5s for fast tools like get_component_tree */
  function getCurrentScm(timeoutMs) {
    const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 10000;
    return new Promise((resolve) => {
      const origSend2 = XMLHttpRequest.prototype.send;
      let resolved = false;
      XMLHttpRequest.prototype.send = function(body) {
        if (!resolved && typeof body === 'string' && body.includes('save2')) {
          // Capture all params
          const fields = body.split('|');
          if (fields.length > 4) capturedGwtHash = fields[4];
          const base36Match = body.match(/\|8\|([A-Za-z0-9]+)\|9\|/);
          if (base36Match) capturedBase36 = base36Match[1];
          const pathEx2 = extractScmFilePathFromRpcBody(body);
          if (pathEx2) capturedFilePath = pathEx2;
          const uuidMatch = body.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          if (uuidMatch) capturedSessionUuid = uuidMatch[1];
          const scmMatch = body.match(/#\\!\n\$JSON\n([\s\S]*?)\n\\!#/);
          if (scmMatch) {
            try {
              capturedScmJson = JSON.parse(scmMatch[1]);
              capturedRpcTemplate = body.replace(scmMatch[1], '___SCM_PLACEHOLDER___');
            } catch(e) {}
          }
          resolved = true;
          XMLHttpRequest.prototype.send = origSend2;
          resolve(!!capturedScmJson);
        }
        return origSend2.apply(this, arguments);
      };
      // Trigger save (Designer APIs are absent in Blocks-only UI — try switching tab first)
      function nudgePropertySave() {
        if (typeof BlocklyPanel_setComponentProperty !== 'function') return false;
        const screen =
          typeof BlocklyPanel_getCurrentScreen === 'function' ? BlocklyPanel_getCurrentScreen() : 'Screen1';
        const title =
          typeof BlocklyPanel_getComponentInstancePropertyValue === 'function'
            ? BlocklyPanel_getComponentInstancePropertyValue(screen, screen, 'Title')
            : 'Screen1';
        BlocklyPanel_setComponentProperty(screen, screen, 'Title', title + ' ', 'Title');
        setTimeout(() => {
          BlocklyPanel_setComponentProperty(screen, screen, 'Title', title, 'Title');
        }, 200);
        return true;
      }
      if (!nudgePropertySave()) {
        trySwitchToDesignerView();
        setTimeout(() => {
          if (!resolved) nudgePropertySave();
        }, 400);
      }
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          XMLHttpRequest.prototype.send = origSend2;
          resolve(false);
        }
      }, limit);
    });
  }

  async function ensureRpcSnapshot() {
    if (capturedRpcTemplate && capturedScmJson) return { ok: true };
    trySwitchToDesignerView();
    await delay(350);
    await getCurrentScm();
    if (capturedRpcTemplate && capturedScmJson) return { ok: true };
    await forceSave2Capture();
    if (capturedRpcTemplate && capturedScmJson) return { ok: true };
    trySwitchToDesignerView();
    await delay(400);
    await getCurrentScm();
    if (capturedRpcTemplate && capturedScmJson) return { ok: true };
    await forceSave2Capture();
    if (capturedRpcTemplate && capturedScmJson) return { ok: true };
    return {
      ok: false,
      error:
        'Could not capture a save2 template. Open the Designer tab, wait for auto-save, then retry.'
    };
  }

  async function ensureScmForTargetScreen(targetScreen) {
    const need = await ensureRpcSnapshot();
    if (!need.ok) return need;
    let cap = screenFromCapturedPath();
    if (cap === targetScreen) return { ok: true };
    if (typeof BlocklyPanel_switchScreen === 'function') {
      try {
        BlocklyPanel_switchScreen(targetScreen);
      } catch (e) {
        console.log('[MCP Bridge] BlocklyPanel_switchScreen:', e);
      }
      await delay(600);
      await getCurrentScm();
      if (!(capturedRpcTemplate && capturedScmJson)) await forceSave2Capture();
    } else {
      trySwitchToDesignerView();
      await delay(300);
      await getCurrentScm();
      if (!(capturedRpcTemplate && capturedScmJson)) await forceSave2Capture();
    }
    cap = screenFromCapturedPath();
    if (capturedRpcTemplate && capturedScmJson && cap === targetScreen) return { ok: true };
    return {
      ok: false,
      error: `Could not load SCM for screen "${targetScreen}" (have "${cap || 'unknown'}"). In the Designer, select "${targetScreen}" in the phone preview, then retry.`
    };
  }

  async function handle_add_components(params) {
    const targetScreen = params.screenName || 'Screen1';
    const mode = params.mode || 'merge';

    const ensured = await ensureScmForTargetScreen(targetScreen);
    if (!ensured.ok) {
      return { success: false, error: ensured.error || 'SCM capture failed' };
    }

    // Get permutation hash from page scripts
    const permHash = extractGwtPermutation();
    if (!permHash) {
      return { success: false, error: 'Could not extract GWT permutation hash from page scripts' };
    }

    // Get or generate session UUID
    const sessionUuid = capturedSessionUuid || generateUuid();
    const filePath = resolveScmFilePath(targetScreen);
    if (!filePath) {
      return {
        success: false,
        error:
          'Could not determine file path. Open the Designer once so the project path is known, then retry.'
      };
    }
    console.log('[MCP Bridge] add_components target:', targetScreen, 'path:', filePath);
    // Get GWT hash (from body) and base36
    const gwtHash = capturedGwtHash || permHash;
    const base36 = capturedBase36 || (function() {
      const pid = resolveOpenProjectId();
      return pid ? parseInt(pid).toString(36).toUpperCase() : null;
    })();
    if (!base36) {
      return { success: false, error: 'Could not determine project ID' };
    }

    // Build SCM and RPC body
    let rpcBody;
    // Determine if captured SCM belongs to the same screen we're targeting
    const capturedScreen = capturedFilePath ? capturedFilePath.replace(/.*\/([^/]+)\.scm$/, '$1') : null;
    const sameScreen = capturedScreen === targetScreen;
    console.log('[MCP Bridge] capturedScreen:', capturedScreen, 'targetScreen:', targetScreen, 'sameScreen:', sameScreen);

    if (capturedScmJson && capturedRpcTemplate && sameScreen) {
      const scm = JSON.parse(JSON.stringify(capturedScmJson));

      // Auto-detect component versions from existing SCM
      const detectedVersions = extractVersionsFromScm(scm);
      const mergedVersions = Object.assign({}, COMPONENT_VERSIONS, detectedVersions);

      if (mode === 'replace') {
        // Replace mode: backward compatible — clears all components
        const startUuid = params.startUuid || (targetScreen === 'Screen1' ? 1 : 1000);
        scm.Properties.$Components = buildComponentNodes(params.components, startUuid, mergedVersions);
      } else {
        // Merge mode (default): preserve existing components, append new ones
        const maxUuid = getMaxUuid(scm.Properties);
        const newNodes = buildComponentNodes(params.components, maxUuid + 1, mergedVersions);

        if (params.parent) {
          // Add inside a specific parent component
          const parentNode = findComponentByName(scm.Properties, params.parent);
          if (!parentNode) {
            return { success: false, error: 'Parent component not found: ' + params.parent };
          }
          const existing = parentNode.$Components || [];
          parentNode.$Components = params.prepend ? newNodes.concat(existing) : existing.concat(newNodes);
        } else {
          // Add to screen root
          scm.Properties.$Components = (scm.Properties.$Components || []).concat(newNodes);
        }
      }

      rpcBody = capturedRpcTemplate.replace('___SCM_PLACEHOLDER___', JSON.stringify(scm));
      if (capturedFilePath && capturedFilePath !== filePath) {
        rpcBody = rpcBody.replace(capturedFilePath, filePath);
      }
    } else {
      if (mode === 'merge') {
        return {
          success: false,
          error: `Cannot merge: SCM is for "${capturedScreen || 'unknown'}" but target is "${targetScreen}". The bridge will switch screens when possible — retry, or select that screen in the Designer.`
        };
      }
      // From-scratch — replace mode only (overwrites screen SCM)
      const startUuid = params.startUuid || (targetScreen === 'Screen1' ? 1 : 1000);
      const scm = {
        authURL: [window.location.hostname],
        YaVersion: '233',
        Source: 'Form',
        Properties: {
          $Name: targetScreen,
          $Type: 'Form',
          $Version: '31',
          ActionBar: 'True',
          AppName: typeof BlocklyPanel_getProjectName === 'function' ? BlocklyPanel_getProjectName() : 'App',
          Title: targetScreen,
          Uuid: '0',
          $Components: buildComponentNodes(params.components, params.startUuid || (targetScreen === 'Screen1' ? 1 : 1000), null)
        }
      };
      const scmContent = '#\\!\n$JSON\n' + JSON.stringify(scm) + '\n\\!#';
      const baseUrl = window.location.origin + '/ode/';
      rpcBody = '7|0|10|' + baseUrl + '|' + gwtHash +
        '|com.google.appinventor.shared.rpc.project.ProjectService|save2|' +
        'java.lang.String/2004016611|J|Z|' + sessionUuid + '|' +
        filePath + '|' + scmContent +
        '|1|2|3|4|5|5|6|5|7|5|8|' + base36 + '|9|0|10|';
    }

    console.log('[MCP Bridge] save2 body length:', rpcBody.length, 'permutation:', permHash);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', window.location.origin + '/ode/projects', false);
      xhr.setRequestHeader('Content-Type', 'text/x-gwt-rpc; charset=UTF-8');
      xhr.setRequestHeader('X-GWT-Module-Base', window.location.origin + '/ode/');
      if (permHash) xhr.setRequestHeader('X-GWT-Permutation', permHash);
      xhr.send(rpcBody);

      console.log('[MCP Bridge] save2 response:', xhr.status, xhr.responseText.substring(0, 300));

      if (xhr.status === 200) {
        // Update cached SCM so subsequent calls see the new state
        const scmMatch = rpcBody.match(/#\\!\n\$JSON\n([\s\S]*?)\n\\!#/);
        if (scmMatch) {
          try { capturedScmJson = JSON.parse(scmMatch[1]); } catch(e) {}
        }
        return {
          success: true,
          componentsAdded: collectNames(params.components),
          reloadRequired: false,
          note: 'Switch screens and back to see changes, or refresh manually.'
        };
      } else {
        return { success: false, error: `save2 failed with status ${xhr.status}: ${xhr.responseText.substring(0, 200)}` };
      }
    } catch (err) {
      return { success: false, error: `save2 error: ${err.message}` };
    }
  }

  function handle_add_blocks(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      if (!ws) return { success: false, error: 'Blockly workspace not available. Switch to Blocks editor.' };

      let xmlStr = params.xml;

      // If structured blocks provided, convert to XML
      if (!xmlStr && params.blocks) {
        xmlStr = '<xml xmlns="https://developers.google.com/blockly/xml">';
        for (const block of params.blocks) {
          xmlStr += structuredToXml(block);
        }
        xmlStr += '</xml>';
      }

      if (!xmlStr) return { success: false, error: 'No xml or blocks provided' };

      const xmlDom = Blockly.utils.xml.textToDom(xmlStr);

      // Don't disable events — App Inventor needs them to trigger auto-save
      const newBlockIds = Blockly.Xml.domToWorkspace(xmlDom, ws);

      // Check for warnings and dropped connections on new blocks
      const warnings = [];
      const droppedInputs = [];
      for (const id of newBlockIds) {
        const block = ws.getBlockById(id);
        if (!block) continue;
        if (block.warning) {
          warnings.push(block.warning.getText());
        }
        // Detect inputs that have a socket but nothing connected
        for (const input of block.inputList) {
          if (input.connection && !input.connection.targetConnection && input.name) {
            droppedInputs.push({
              blockId: id,
              blockType: block.type,
              inputName: input.name
            });
          }
        }
      }

      // Force App Inventor to save blocks by firing a synthetic change event
      try {
        if (typeof BlocklyPanel_blocklyWorkspaceChanged === 'function') {
          BlocklyPanel_blocklyWorkspaceChanged(ws);
        }
      } catch(e) { /* best effort */ }

      return {
        success: true,
        blocksAdded: newBlockIds.length,
        warnings,
        droppedInputs: droppedInputs.length > 0 ? droppedInputs : undefined
      };
    } catch (err) {
      return { success: false, error: `Block injection error: ${err.message}` };
    }
  }

  /**
   * Replace the entire Blockly workspace from XML (round-trip with get_blocks format: xml).
   * Use only with XML from get_blocks or trusted patches; clears the workspace first.
   */
  function handle_set_blocks_xml(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      if (!ws) return { success: false, error: 'Blockly workspace not available. Switch to Blocks editor.' };
      let xmlStr = params.xml;
      if ((!xmlStr || typeof xmlStr !== 'string') && params.xmlBase64 && typeof params.xmlBase64 === 'string') {
        try {
          const bin = atob(params.xmlBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          xmlStr = new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
          return { success: false, error: 'Invalid xmlBase64: ' + e.message };
        }
      }
      if (!xmlStr || typeof xmlStr !== 'string') {
        return { success: false, error: 'Missing or invalid xml / xmlBase64' };
      }
      const xmlDom = Blockly.utils.xml.textToDom(xmlStr);
      ws.clear();
      Blockly.Xml.domToWorkspace(xmlDom, ws);
      try {
        if (typeof BlocklyPanel_blocklyWorkspaceChanged === 'function') {
          BlocklyPanel_blocklyWorkspaceChanged(ws);
        }
      } catch (e) {
        /* best effort */
      }
      return { success: true, totalBlocks: ws.getAllBlocks(false).length };
    } catch (err) {
      return { success: false, error: `set_blocks_xml error: ${err.message}` };
    }
  }

  function handle_get_blocks(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      if (!ws) return { success: false, error: 'Blockly workspace not available' };

      const format = params.format || 'xml';

      if (format === 'xml') {
        const dom = Blockly.Xml.workspaceToDom(ws);
        const xml = Blockly.utils.xml.domToText(dom);
        return { success: true, xml };
      }

      // Summary format
      const allBlocks = ws.getAllBlocks(false);
      const eventHandlers = [];
      const variables = [];
      const procedures = [];
      let orphanedBlocks = 0;
      const warnings = [];

      for (const block of allBlocks) {
        if (block.type === 'component_event') {
          const mutation = block.mutationToDom && block.mutationToDom();
          eventHandlers.push({
            component: block.getFieldValue('COMPONENT_SELECTOR'),
            event: mutation ? mutation.getAttribute('event_name') : 'unknown',
            blockCount: block.getDescendants(false).length
          });
        }
        if (block.type === 'global_declaration') {
          variables.push(block.getFieldValue('NAME'));
        }
        if (block.type === 'procedures_defnoreturn' || block.type === 'procedures_defreturn') {
          procedures.push({
            name: block.getFieldValue('NAME'),
            hasReturn: block.type === 'procedures_defreturn',
            paramCount: block.arguments_ ? block.arguments_.length : 0
          });
        }
        if (!block.getParent() && block.type !== 'component_event' && block.type !== 'global_declaration' && !block.type.startsWith('procedures_def')) {
          orphanedBlocks++;
        }
        if (block.warning) {
          warnings.push({ blockType: block.type, message: block.warning.getText() });
        }
      }

      return {
        success: true,
        eventHandlers,
        variables,
        procedures,
        totalBlocks: allBlocks.length,
        warnings,
        orphanedBlocks
      };
    } catch (err) {
      return { success: false, error: `get_blocks error: ${err.message}` };
    }
  }

  function handle_get_block_diagnostics() {
    try {
      const ws = Blockly.getMainWorkspace();
      if (!ws) return { success: false, error: 'Blockly workspace not available' };

      const allBlocks = ws.getAllBlocks(false);
      const warnings = [];
      const orphanedBlocks = [];
      let connectedBlocks = 0;

      for (const block of allBlocks) {
        if (block.warning) {
          warnings.push({
            blockId: block.id,
            blockType: block.type,
            component: block.getFieldValue('COMPONENT_SELECTOR') || null,
            message: block.warning.getText()
          });
        }
        if (block.getParent()) {
          connectedBlocks++;
        } else if (block.type !== 'component_event' && block.type !== 'global_declaration' && !block.type.startsWith('procedures_def')) {
          orphanedBlocks.push({ blockId: block.id, blockType: block.type });
        }
      }

      return {
        success: true,
        warnings,
        orphanedBlocks,
        totalBlocks: allBlocks.length,
        connectedBlocks
      };
    } catch (err) {
      return { success: false, error: `diagnostics error: ${err.message}` };
    }
  }

  function handle_get_all_component_types() {
    try {
      if (typeof BlocklyPanel_getComponentsJSONString === 'function') {
        const json = BlocklyPanel_getComponentsJSONString();
        const catalog = JSON.parse(json);
        return { success: true, components: catalog };
      }
      return { success: false, error: 'BlocklyPanel_getComponentsJSONString not available' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_get_component_schema(params) {
    try {
      if (typeof BlocklyPanel_getComponentInfo === 'function') {
        const info = BlocklyPanel_getComponentInfo(params.componentType);
        if (info) return { success: true, ...JSON.parse(info) };
      }
      return { success: false, error: `Unknown component type: ${params.componentType}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_search_components(params) {
    try {
      const query = (params.query || '').toLowerCase();
      if (typeof BlocklyPanel_getComponentsJSONString !== 'function') {
        return { success: false, error: 'Component catalog not available' };
      }
      const catalog = JSON.parse(BlocklyPanel_getComponentsJSONString());
      const matches = catalog.filter(c =>
        c.type.toLowerCase().includes(query) ||
        (c.category && c.category.toLowerCase().includes(query))
      );
      return { success: true, matches };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_take_screenshot() {
    // Can't easily screenshot from page context; return a stub
    return { success: false, error: 'Screenshot not available from page bridge (use Chrome DevTools)' };
  }

  function handle_reload_designer() {
    // Instead of location.reload() which kills WebSocket + session state,
    // try switching screens and back to force a designer refresh
    try {
      const currentScreen = typeof BlocklyPanel_getCurrentScreen === 'function'
        ? BlocklyPanel_getCurrentScreen() : null;

      if (currentScreen && typeof BlocklyPanel_switchScreen === 'function') {
        // Try to find another screen to switch to and back
        // This forces App Inventor to re-render the designer
        BlocklyPanel_switchScreen(currentScreen);
        return { success: true, method: 'screen_refresh', note: 'Designer refreshed via screen switch.' };
      }

      // Fallback: trigger a property toggle to force re-render
      if (typeof BlocklyPanel_setComponentProperty === 'function') {
        const screen = currentScreen || 'Screen1';
        const title = typeof BlocklyPanel_getComponentInstancePropertyValue === 'function'
          ? BlocklyPanel_getComponentInstancePropertyValue(screen, screen, 'Title') : screen;
        BlocklyPanel_setComponentProperty(screen, screen, 'Title', title + ' ', 'Title');
        setTimeout(() => {
          BlocklyPanel_setComponentProperty(screen, screen, 'Title', title, 'Title');
        }, 200);
        return { success: true, method: 'property_toggle', note: 'Triggered re-render via property toggle.' };
      }

      // Last resort: full reload (warns user)
      location.reload();
      return { success: true, method: 'full_reload', note: 'Full page reload — session params will need re-capture.' };
    } catch (err) {
      return { success: false, error: `reload error: ${err.message}` };
    }
  }

  function handle_clear_blocks(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      if (!ws) return { success: false, error: 'Workspace not available' };

      if (params.blockIds && params.blockIds.length > 0) {
        let removed = 0;
        for (const id of params.blockIds) {
          const block = ws.getBlockById(id);
          if (block) { block.dispose(true); removed++; }
        }
        return { success: true, blocksRemoved: removed };
      }

      const count = ws.getAllBlocks(false).length;
      ws.clear();
      return { success: true, blocksRemoved: count };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_modify_block(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      const block = ws.getBlockById(params.blockId);
      if (!block) return { success: false, error: `Block ${params.blockId} not found` };
      block.setFieldValue(params.newValue, params.fieldName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_undo(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      const steps = params.steps || 1;
      for (let i = 0; i < steps; i++) ws.undo(false);
      return { success: true, remainingUndos: ws.undoStack_.length, remainingRedos: ws.redoStack_.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handle_redo(params) {
    try {
      const ws = Blockly.getMainWorkspace();
      const steps = params.steps || 1;
      for (let i = 0; i < steps; i++) ws.undo(true);
      return { success: true, remainingUndos: ws.undoStack_.length, remainingRedos: ws.redoStack_.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function removeFromScmTree(node, names) {
    if (!node.$Components) return;
    node.$Components = node.$Components.filter((c) => !names.includes(c.$Name));
    for (const child of node.$Components) {
      removeFromScmTree(child, names);
    }
  }

  async function saveScmViaRpc(scm, targetScreen) {
    const permHash = extractGwtPermutation();
    if (!permHash) {
      return { success: false, error: 'Could not extract GWT permutation hash from page scripts' };
    }
    if (!capturedRpcTemplate || !capturedScmJson) {
      const snap = await ensureRpcSnapshot();
      if (!snap.ok || !capturedRpcTemplate) {
        return {
          success: false,
          error: snap.error || 'No save template. Open the Designer, wait for auto-save, then retry.'
        };
      }
    }
    const filePath = resolveScmFilePath(targetScreen);
    if (!filePath) {
      return {
        success: false,
        error: 'Could not determine file path. Open the Designer once, then retry.'
      };
    }
    const scmJsonStr = JSON.stringify(scm);
    let rpcBody = capturedRpcTemplate.replace('___SCM_PLACEHOLDER___', scmJsonStr);
    if (capturedFilePath && capturedFilePath !== filePath) {
      rpcBody = rpcBody.replace(capturedFilePath, filePath);
    }
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', window.location.origin + '/ode/projects', false);
      xhr.setRequestHeader('Content-Type', 'text/x-gwt-rpc; charset=UTF-8');
      xhr.setRequestHeader('X-GWT-Module-Base', window.location.origin + '/ode/');
      if (permHash) xhr.setRequestHeader('X-GWT-Permutation', permHash);
      xhr.send(rpcBody);
      if (xhr.status === 200) {
        const scmMatch = rpcBody.match(/#\\!\n\$JSON\n([\s\S]*?)\n\\!#/);
        if (scmMatch) {
          try {
            capturedScmJson = JSON.parse(scmMatch[1]);
          } catch (e) {
            /* keep previous */
          }
        }
        return { success: true };
      }
      return {
        success: false,
        error: `save2 failed with status ${xhr.status}: ${xhr.responseText.substring(0, 200)}`
      };
    } catch (err) {
      return { success: false, error: `save2 error: ${err.message}` };
    }
  }

  async function handle_update_component_properties(params) {
    try {
      const screenName = params.screenName || 'Screen1';
      if (!params.componentName) {
        return { success: false, error: 'componentName is required' };
      }
      if (!params.properties || typeof params.properties !== 'object') {
        return { success: false, error: 'properties object is required' };
      }
      const cap = await ensureScmForTargetScreen(screenName);
      if (!cap.ok || !capturedScmJson) {
        return {
          success: false,
          error: cap.error || 'Could not read component tree for that screen.'
        };
      }
      const scm = JSON.parse(JSON.stringify(capturedScmJson));
      const comp = findComponentByName(scm.Properties, params.componentName);
      if (!comp) {
        return { success: false, error: `Component "${params.componentName}" not found` };
      }
      const updated = [];
      for (const [k, v] of Object.entries(params.properties)) {
        comp[k] = String(v);
        updated.push(k);
      }
      const out = await saveScmViaRpc(scm, screenName);
      if (!out.success) return out;
      return { success: true, updatedProperties: updated };
    } catch (err) {
      return { success: false, error: `Failed to update properties: ${err.message}` };
    }
  }

  async function handle_remove_components(params) {
    try {
      const screenName = params.screenName || 'Screen1';
      const names = params.componentNames;
      if (!Array.isArray(names) || names.length === 0) {
        return { success: false, error: 'componentNames (non-empty array) is required' };
      }
      const cap = await ensureScmForTargetScreen(screenName);
      if (!cap.ok || !capturedScmJson) {
        return {
          success: false,
          error: cap.error || 'Could not read component tree for that screen.'
        };
      }
      const scm = JSON.parse(JSON.stringify(capturedScmJson));
      removeFromScmTree(scm.Properties, names);
      const out = await saveScmViaRpc(scm, screenName);
      if (!out.success) return out;
      return { success: true, removedComponents: names };
    } catch (err) {
      return { success: false, error: `Failed to remove components: ${err.message}` };
    }
  }

  // --- Helpers ---

  function getMaxUuid(node) {
    let max = 0;
    if (node.Uuid) max = Math.max(max, parseInt(node.Uuid) || 0);
    if (node.$Components) {
      for (const child of node.$Components) {
        max = Math.max(max, getMaxUuid(child));
      }
    }
    if (node.Properties) max = Math.max(max, getMaxUuid(node.Properties));
    return max;
  }

  function findComponentByName(node, name) {
    if (node.$Name === name) return node;
    const children = node.$Components || (node.Properties && node.Properties.$Components) || [];
    for (const child of children) {
      const found = findComponentByName(child, name);
      if (found) return found;
    }
    return null;
  }

  function extractVersionsFromScm(node) {
    const versions = {};
    if (node.$Type && node.$Version) versions[node.$Type] = node.$Version;
    if (node.$Components) {
      for (const child of node.$Components) {
        Object.assign(versions, extractVersionsFromScm(child));
      }
    }
    if (node.Properties) Object.assign(versions, extractVersionsFromScm(node.Properties));
    return versions;
  }

  const COMPONENT_VERSIONS = {
    // UI
    Form: '31', Button: '7', Label: '5', TextBox: '14', PasswordTextBox: '7',
    CheckBox: '3', Switch: '2', Slider: '2', Spinner: '2', ListPicker: '9',
    DatePicker: '4', TimePicker: '4', Image: '5', ListView: '10', WebViewer: '10',
    // Layout
    VerticalArrangement: '4', HorizontalArrangement: '4', TableArrangement: '2',
    // Media
    Camcorder: '2', Camera: '4', ImagePicker: '6', Player: '7', Sound: '4',
    SpeechRecognizer: '3', TextToSpeech: '5', VideoPlayer: '7',
    // Drawing & Animation
    Canvas: '14',
    // Maps
    Map: '7', Marker: '4', Circle: '2', LineString: '2', Polygon: '2', Rectangle: '2',
    // Sensors
    AccelerometerSensor: '5', LocationSensor: '4', OrientationSensor: '2',
    BarcodeScannerComponent: '2', NearField: '2', Pedometer: '3', ProximitySensor: '2',
    Clock: '4',
    // Social
    ContactPicker: '6', EmailPicker: '4', PhoneCall: '3', PhoneNumberPicker: '5',
    Sharing: '2', Texting: '5', Twitter: '5',
    // Storage
    TinyDB: '3', File: '4', CloudDB: '2', FirebaseDB: '3', FusiontablesControl: '4',
    // Connectivity
    Web: '7', ActivityStarter: '7', BluetoothClient: '8', BluetoothServer: '5',
    // Non-visible
    Notifier: '6'
  };

  function buildComponentNodes(specs, nextUuid, versions) {
    const versionMap = versions || COMPONENT_VERSIONS;
    const nodes = [];
    for (const spec of specs) {
      const node = {
        $Name: spec.name,
        $Type: spec.type,
        $Version: versionMap[spec.type] || COMPONENT_VERSIONS[spec.type] || '1',
        Uuid: String(nextUuid++)
      };
      if (spec.properties) {
        for (const [k, v] of Object.entries(spec.properties)) {
          node[k] = String(v);
        }
      }
      if (spec.children && spec.children.length > 0) {
        node.$Components = buildComponentNodes(spec.children, nextUuid, versionMap);
        nextUuid += countComponents(spec.children);
      }
      nodes.push(node);
    }
    return nodes;
  }

  // Find the highest UUID in an SCM tree to avoid conflicts when appending
  function getMaxUuid(node) {
    let max = parseInt(node.Uuid || '0', 10) || 0;
    if (node.$Components) {
      for (const child of node.$Components) {
        max = Math.max(max, getMaxUuid(child));
      }
    }
    return max;
  }

  function countComponents(specs) {
    let count = 0;
    for (const s of specs) {
      count++;
      if (s.children) count += countComponents(s.children);
    }
    return count;
  }

  function collectNames(specs) {
    const names = [];
    for (const s of specs) {
      names.push(s.name);
      if (s.children) names.push(...collectNames(s.children));
    }
    return names;
  }

  function structuredToXml(block) {
    // Handle next block chaining
    const nextXml = block.next ? `<next>${structuredToXml(block.next)}</next>` : '';

    switch (block.type) {
      // --- App Inventor Component Blocks ---
      case 'event_handler':
        return '<block type="component_event" x="50" y="50">' +
          `<mutation component_type="${block.componentType}" instance_name="${block.component}" event_name="${block.event}"></mutation>` +
          `<field name="COMPONENT_SELECTOR">${block.component}</field>` +
          (block.body ? '<statement name="DO">' + block.body.map(structuredToXml).join('') + '</statement>' : '') +
          '</block>';

      case 'set_property':
        return '<block type="component_set_get">' +
          `<mutation component_type="${block.componentType}" set_or_get="set" property_name="${block.property}" is_generic="false" instance_name="${block.component}"></mutation>` +
          `<field name="COMPONENT_SELECTOR">${block.component}</field>` +
          `<field name="PROP">${block.property}</field>` +
          (block.value ? `<value name="VALUE">${structuredToXml(block.value)}</value>` : '') +
          nextXml + '</block>';

      case 'get_property':
        return '<block type="component_set_get">' +
          `<mutation component_type="${block.componentType}" set_or_get="get" property_name="${block.property}" is_generic="false" instance_name="${block.component}"></mutation>` +
          `<field name="COMPONENT_SELECTOR">${block.component}</field>` +
          `<field name="PROP">${block.property}</field>` +
          '</block>';

      case 'call_method': {
        let xml = '<block type="component_method">' +
          `<mutation component_type="${block.componentType}" method_name="${block.method}" instance_name="${block.component}" is_generic="false"></mutation>` +
          `<field name="COMPONENT_SELECTOR">${block.component}</field>`;
        if (block.args) {
          block.args.forEach((arg, i) => { xml += `<value name="ARG${i}">${structuredToXml(arg)}</value>`; });
        }
        return xml + nextXml + '</block>';
      }

      // --- Variables ---
      case 'global_declaration':
        return '<block type="global_declaration" x="50" y="50">' +
          `<field name="NAME">${block.name}</field>` +
          (block.value ? `<value name="VALUE">${structuredToXml(block.value)}</value>` : '') +
          '</block>';

      case 'variable_get':
        return `<block type="lexical_variable_get"><field name="VAR">${block.variable || block.name}</field></block>`;

      case 'variable_set':
        return '<block type="lexical_variable_set">' +
          `<field name="VAR">${block.variable || block.name}</field>` +
          (block.value ? `<value name="VALUE">${structuredToXml(block.value)}</value>` : '') +
          nextXml + '</block>';

      // --- Control Flow ---
      case 'controls_if': {
        const elseifCount = block.elseif ? block.elseif.length : 0;
        const hasElse = !!block.else;
        let xml = `<block type="controls_if"><mutation elseif="${elseifCount}" else="${hasElse ? 1 : 0}"></mutation>`;
        // Primary if condition
        if (block.condition) xml += `<value name="IF0">${structuredToXml(block.condition)}</value>`;
        if (block.then) xml += `<statement name="DO0">${block.then.map(structuredToXml).join('')}</statement>`;
        // Elseif branches
        if (block.elseif) {
          block.elseif.forEach((branch, i) => {
            if (branch.condition) xml += `<value name="IF${i + 1}">${structuredToXml(branch.condition)}</value>`;
            if (branch.then) xml += `<statement name="DO${i + 1}">${branch.then.map(structuredToXml).join('')}</statement>`;
          });
        }
        // Else branch
        if (block.else) xml += `<statement name="ELSE">${block.else.map(structuredToXml).join('')}</statement>`;
        return xml + nextXml + '</block>';
      }

      case 'controls_forRange':
        return '<block type="controls_forRange">' +
          `<field name="VAR">${block.variable || 'i'}</field>` +
          (block.from ? `<value name="START">${structuredToXml(block.from)}</value>` : '') +
          (block.to ? `<value name="END">${structuredToXml(block.to)}</value>` : '') +
          (block.by ? `<value name="STEP">${structuredToXml(block.by)}</value>` : '') +
          (block.body ? `<statement name="DO">${block.body.map(structuredToXml).join('')}</statement>` : '') +
          nextXml + '</block>';

      case 'controls_forEach':
        return '<block type="controls_forEach">' +
          `<field name="VAR">${block.variable || 'item'}</field>` +
          (block.list ? `<value name="LIST">${structuredToXml(block.list)}</value>` : '') +
          (block.body ? `<statement name="DO">${block.body.map(structuredToXml).join('')}</statement>` : '') +
          nextXml + '</block>';

      case 'controls_while':
        return '<block type="controls_while">' +
          (block.condition ? `<value name="TEST">${structuredToXml(block.condition)}</value>` : '') +
          (block.body ? `<statement name="DO">${block.body.map(structuredToXml).join('')}</statement>` : '') +
          nextXml + '</block>';

      // --- Logic ---
      case 'logic_compare':
        return '<block type="logic_compare">' +
          `<field name="OP">${block.op || 'EQ'}</field>` +
          (block.a ? `<value name="A">${structuredToXml(block.a)}</value>` : '') +
          (block.b ? `<value name="B">${structuredToXml(block.b)}</value>` : '') +
          '</block>';

      case 'logic_operation':
        return '<block type="logic_operation">' +
          `<field name="OP">${block.op || 'AND'}</field>` +
          (block.a ? `<value name="A">${structuredToXml(block.a)}</value>` : '') +
          (block.b ? `<value name="B">${structuredToXml(block.b)}</value>` : '') +
          '</block>';

      case 'logic_negate':
        return '<block type="logic_negate">' +
          (block.value ? `<value name="BOOL">${structuredToXml(block.value)}</value>` : '') +
          '</block>';

      // --- Math ---
      case 'math_arithmetic':
        return '<block type="math_arithmetic">' +
          `<field name="OP">${block.op || 'ADD'}</field>` +
          (block.a ? `<value name="A">${structuredToXml(block.a)}</value>` : '') +
          (block.b ? `<value name="B">${structuredToXml(block.b)}</value>` : '') +
          '</block>';

      case 'math_compare':
        return '<block type="math_compare">' +
          `<field name="OP">${block.op || 'EQ'}</field>` +
          (block.a ? `<value name="A">${structuredToXml(block.a)}</value>` : '') +
          (block.b ? `<value name="B">${structuredToXml(block.b)}</value>` : '') +
          '</block>';

      // --- Text ---
      case 'text_join': {
        const items = block.items || [];
        let xml = `<block type="text_join"><mutation items="${items.length}"></mutation>`;
        items.forEach((item, i) => { xml += `<value name="ADD${i}">${structuredToXml(item)}</value>`; });
        return xml + '</block>';
      }

      // --- Lists ---
      case 'lists_create_with': {
        const listItems = block.items || [];
        let xml = `<block type="lists_create_with"><mutation items="${listItems.length}"></mutation>`;
        listItems.forEach((item, i) => { xml += `<value name="ADD${i}">${structuredToXml(item)}</value>`; });
        return xml + '</block>';
      }

      case 'lists_add_items':
        return '<block type="lists_add_items">' +
          (block.list ? `<value name="LIST">${structuredToXml(block.list)}</value>` : '') +
          (block.item ? `<value name="ITEM">${structuredToXml(block.item)}</value>` : '') +
          nextXml + '</block>';

      // --- Procedures ---
      case 'procedures_defnoreturn': {
        let xml = '<block type="procedures_defnoreturn" x="50" y="50">' +
          `<field name="NAME">${block.name}</field>`;
        if (block.params && block.params.length > 0) {
          xml += `<mutation><arg name="${block.params.join('"></arg><arg name="')}"></arg></mutation>`;
        }
        if (block.body) xml += `<statement name="STACK">${block.body.map(structuredToXml).join('')}</statement>`;
        return xml + '</block>';
      }

      case 'procedures_defreturn': {
        let xml = '<block type="procedures_defreturn" x="50" y="50">' +
          `<field name="NAME">${block.name}</field>`;
        if (block.params && block.params.length > 0) {
          xml += `<mutation><arg name="${block.params.join('"></arg><arg name="')}"></arg></mutation>`;
        }
        if (block.body) xml += `<statement name="STACK">${block.body.map(structuredToXml).join('')}</statement>`;
        if (block.returnValue) xml += `<value name="RETURN">${structuredToXml(block.returnValue)}</value>`;
        return xml + '</block>';
      }

      case 'procedures_callnoreturn': {
        let xml = '<block type="procedures_callnoreturn">' +
          `<mutation name="${block.name}">`;
        if (block.args) block.args.forEach(a => { xml += `<arg name="${a.name}"></arg>`; });
        xml += '</mutation>';
        if (block.args) block.args.forEach((a, i) => { xml += `<value name="ARG${i}">${structuredToXml(a.value)}</value>`; });
        return xml + nextXml + '</block>';
      }

      case 'procedures_callreturn': {
        let xml = '<block type="procedures_callreturn">' +
          `<mutation name="${block.name}">`;
        if (block.args) block.args.forEach(a => { xml += `<arg name="${a.name}"></arg>`; });
        xml += '</mutation>';
        if (block.args) block.args.forEach((a, i) => { xml += `<value name="ARG${i}">${structuredToXml(a.value)}</value>`; });
        return xml + '</block>';
      }

      // --- Primitives ---
      case 'text':
        return `<block type="text"><field name="TEXT">${escapeXml(block.value || '')}</field></block>`;
      case 'number':
        return `<block type="math_number"><field name="NUM">${block.value || 0}</field></block>`;
      case 'boolean':
        return `<block type="logic_boolean"><field name="BOOL">${block.value ? 'TRUE' : 'FALSE'}</field></block>`;
      case 'color':
        return `<block type="color_make_color"><value name="COLORLIST">${structuredToXml(block.value)}</value></block>`;
      case 'empty_string':
        return '<block type="text"><field name="TEXT"></field></block>';

      default:
        // Allow raw block type passthrough for anything not covered
        if (block.rawType) {
          let xml = `<block type="${block.rawType}">`;
          if (block.fields) {
            for (const [name, val] of Object.entries(block.fields)) {
              xml += `<field name="${name}">${val}</field>`;
            }
          }
          if (block.values) {
            for (const [name, val] of Object.entries(block.values)) {
              xml += `<value name="${name}">${structuredToXml(val)}</value>`;
            }
          }
          if (block.statements) {
            for (const [name, stmts] of Object.entries(block.statements)) {
              xml += `<statement name="${name}">${stmts.map(structuredToXml).join('')}</statement>`;
            }
          }
          return xml + nextXml + '</block>';
        }
        console.warn('[MCP Bridge] Unknown structured block type:', block.type);
        return '';
    }
  }

  // Escape XML special characters in text values
  function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Router ---
  const TOOL_HANDLERS = {
    get_project_info: handle_get_project_info,
    get_component_tree: handle_get_component_tree,
    get_component_schema: handle_get_component_schema,
    get_all_component_types: handle_get_all_component_types,
    get_blocks: handle_get_blocks,
    get_block_diagnostics: handle_get_block_diagnostics,
    search_components: handle_search_components,
    add_components: handle_add_components,
    add_blocks: handle_add_blocks,
    set_blocks_xml: handle_set_blocks_xml,
    clear_blocks: handle_clear_blocks,
    modify_block: handle_modify_block,
    take_screenshot: handle_take_screenshot,
    reload_designer: handle_reload_designer,
    undo: handle_undo,
    redo: handle_redo,
    update_component_properties: handle_update_component_properties,
    remove_components: handle_remove_components
  };

  // --- Message listener ---
  // Do not filter on event.source: content-script isolated world postMessage can fail event.source === window.
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== `${BRIDGE_PREFIX}request`) return;

    const { requestId, tool, params } = event.data;

    const handler = TOOL_HANDLERS[tool];
    if (!handler) {
      window.postMessage({ type: `${BRIDGE_PREFIX}response`, requestId, result: { success: false, error: `Unknown tool: ${tool}` } }, '*');
      return;
    }

    Promise.resolve()
      .then(() => handler(params || {}))
      .then((result) => {
        window.postMessage({ type: `${BRIDGE_PREFIX}response`, requestId, result }, '*');
      })
      .catch((err) => {
        window.postMessage({ type: `${BRIDGE_PREFIX}response`, requestId, result: { success: false, error: `Tool error: ${err.message}` } }, '*');
      });
  });

  // Extract GWT permutation hash on load
  extractGwtPermutation();

  // --- Cache-first: load cached session params on startup ---
  window.addEventListener('message', function cacheListener(event) {
    if (!event.data || event.data.type !== BRIDGE_PREFIX + 'cache-data') return;

    const data = event.data.data;
    if (data) {
      if (data.sessionUuid) capturedSessionUuid = data.sessionUuid;
      if (data.gwtHash) capturedGwtHash = data.gwtHash;
      if (data.filePath) capturedFilePath = data.filePath;
      if (data.base36) capturedBase36 = data.base36;
      if (data.scmJson) capturedScmJson = data.scmJson;
      if (data.rpcTemplate) capturedRpcTemplate = data.rpcTemplate;
      console.log('[MCP Bridge] Loaded cached session params:', {
        sessionUuid: !!capturedSessionUuid, gwtHash: !!capturedGwtHash,
        filePath: !!capturedFilePath, base36: !!capturedBase36,
        hasScm: !!capturedScmJson, hasTemplate: !!capturedRpcTemplate
      });
    } else {
      console.log('[MCP Bridge] No cached session params found');
    }
    // Remove one-time listener
    window.removeEventListener('message', cacheListener);
  });

  // Request cached params from content script
  window.postMessage({ type: BRIDGE_PREFIX + 'cache-read' }, '*');

  // Auto-capture session params on load if not cached
  // Wait for App Inventor to fully load, then force a save2 to capture params
  function autoCapture() {
    if (capturedScmJson && capturedRpcTemplate) {
      console.log('[MCP Bridge] Session params already available, skipping auto-capture');
      return;
    }
    // Check if App Inventor is ready
    if (typeof BlocklyPanel_setComponentProperty !== 'function') {
      // Not ready yet, retry
      console.log('[MCP Bridge] App Inventor not ready, retrying auto-capture in 3s...');
      setTimeout(autoCapture, 3000);
      return;
    }
    console.log('[MCP Bridge] Auto-capturing session params...');
    forceSave2Capture().then((success) => {
      if (success) {
        console.log('[MCP Bridge] Auto-capture successful');
      } else {
        console.log('[MCP Bridge] Auto-capture failed, will capture on first tool call');
      }
    });
  }
  // Start auto-capture after a delay to let App Inventor initialize
  setTimeout(autoCapture, 4000);

  // Expose tool dispatch globally so background can call via executeScript
  window.__mcpBridge = async function(tool, params) {
    const handler = TOOL_HANDLERS[tool];
    if (!handler) return { success: false, error: `Unknown tool: ${tool}` };
    try {
      return await handler(params || {});
    } catch (err) {
      return { success: false, error: `Tool error: ${err.message}` };
    }
  };

  console.log('[MCP Bridge] Page bridge loaded, tools ready');
})();
