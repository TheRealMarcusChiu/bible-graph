/* ─────────────────────────────────────────────────────────────────────────────
 *  webgl-graph.js — experimental WebGL renderer for the Knowledge Garden graph.
 *
 *  A drop-in stand-in for the force-graph instance: it exposes the same subset
 *  of the force-graph API that index.html uses (graphData, zoom, centerAt,
 *  screen2GraphCoords, d3ReheatSimulation, …) so the rest of the app doesn't
 *  care which renderer is active.
 *
 *  Architecture:
 *    • layout   — d3-force on the CPU (same forces/params as the canvas mode,
 *                 so both renderers produce the same layout).
 *    • bulk     — one WebGL canvas draws EVERY node (as anti-aliased discs) and
 *                 EVERY edge (as GL lines) in two draw calls, so tens of
 *                 thousands of elements render at 60fps.
 *    • overlay  — a small 2D canvas on top draws only the "hero" elements
 *                 (root emblem, anchored-node pulse, hover ring, glow, labels,
 *                 hot edges) by delegating to the app's own draw2d(), keeping
 *                 the exact look of the canvas renderer for what matters.
 *
 *  The GL canvas uses preserveDrawingBuffer so PNG export & screenshots work.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var NODE_VS = [
    'attribute vec2 aPos;',
    'attribute vec2 aCorner;',
    'attribute float aSize;',
    'attribute vec4 aColor;',
    'uniform vec2 uCenter;',
    'uniform float uZoom;',
    'uniform vec2 uViewport;',
    'varying vec4 vColor;',
    'varying vec2 vUV;',
    'varying float vRadPx;',
    'void main() {',
    '  float rp = max(aSize * uZoom, 0.75);',            // radius in css px
    '  vec2 s = (aPos - uCenter) * uZoom + aCorner * (rp + 1.5);',
    '  gl_Position = vec4(2.0 * s.x / uViewport.x, -2.0 * s.y / uViewport.y, 0.0, 1.0);',
    '  vUV = aCorner * ((rp + 1.5) / rp);',
    '  vRadPx = rp;',
    '  vColor = aColor;',
    '}'].join('\n');

  var NODE_FS = [
    'precision mediump float;',
    'varying vec4 vColor;',
    'varying vec2 vUV;',
    'varying float vRadPx;',
    'void main() {',
    '  float r = length(vUV);',
    '  float aa = 1.5 / max(vRadPx, 1.5);',
    '  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);',
    '  if (alpha <= 0.004) discard;',
    '  vec3 rgb = vColor.rgb;',
    // dark inner core, mirroring draw2d's 0.42r overlay
    '  float core = 1.0 - smoothstep(0.34, 0.46, r);',
    '  rgb = mix(rgb, vec3(0.059, 0.047, 0.035), core * 0.55);',
    '  float a = vColor.a * alpha;',
    '  gl_FragColor = vec4(rgb * a, a);',                 // premultiplied
    '}'].join('\n');

  var LINK_VS = [
    'attribute vec2 aPos;',
    'attribute vec4 aColor;',
    'uniform vec2 uCenter;',
    'uniform float uZoom;',
    'uniform vec2 uViewport;',
    'varying vec4 vColor;',
    'void main() {',
    '  vec2 s = (aPos - uCenter) * uZoom;',
    '  gl_Position = vec4(2.0 * s.x / uViewport.x, -2.0 * s.y / uViewport.y, 0.0, 1.0);',
    '  vColor = aColor;',
    '}'].join('\n');

  var LINK_FS = [
    'precision mediump float;',
    'varying vec4 vColor;',
    'void main() { gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a); }'].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  // CSS color string -> [r,g,b,a] floats (cached).
  var colorCache = {};
  function parseColor(c) {
    if (!c) return [1, 1, 1, 1];
    var hit = colorCache[c];
    if (hit) return hit;
    var out = [1, 1, 1, 1], m;
    if (c[0] === '#') {
      var h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      out = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
    } else if ((m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(c))) {
      out = [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] == null ? 1 : +m[4]];
    }
    colorCache[c] = out;
    return out;
  }

  var QUAD = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

  function KGWebGLGraph(el, comp) {
    this.el = el;
    this.comp = comp;
    this._nodes = [];
    this._links = [];
    this._onTick = null;
    this._onStop = null;
    this._lcFn = null; this._lwFn = null; this._lpcFn = null;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._w = el.clientWidth || 300;
    this._h = el.clientHeight || 150;
    this._cam = { x: 0, y: 0, z: 1 };
    this._tween = null;
    this._posDirty = true;
    this._styleDirty = true;
    this._styleSig = '';
    this._dead = false;

    // ---- canvases ----
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;display:block;';
    el.appendChild(cv);
    this.cv = cv;
    var ov = document.createElement('canvas');
    ov.style.cssText = 'position:absolute;inset:0;display:block;pointer-events:none;';
    el.appendChild(ov);
    this.ov = ov;
    this.octx = ov.getContext('2d');

    var gl = cv.getContext('webgl', { alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this._pNode = program(gl, NODE_VS, NODE_FS);
    this._pLink = program(gl, LINK_VS, LINK_FS);
    this._loc = {
      n: {
        aPos: gl.getAttribLocation(this._pNode, 'aPos'),
        aCorner: gl.getAttribLocation(this._pNode, 'aCorner'),
        aSize: gl.getAttribLocation(this._pNode, 'aSize'),
        aColor: gl.getAttribLocation(this._pNode, 'aColor'),
        uCenter: gl.getUniformLocation(this._pNode, 'uCenter'),
        uZoom: gl.getUniformLocation(this._pNode, 'uZoom'),
        uViewport: gl.getUniformLocation(this._pNode, 'uViewport'),
      },
      l: {
        aPos: gl.getAttribLocation(this._pLink, 'aPos'),
        aColor: gl.getAttribLocation(this._pLink, 'aColor'),
        uCenter: gl.getUniformLocation(this._pLink, 'uCenter'),
        uZoom: gl.getUniformLocation(this._pLink, 'uZoom'),
        uViewport: gl.getUniformLocation(this._pLink, 'uViewport'),
      },
    };
    this._bufNodePos = gl.createBuffer();
    this._bufNodeStatic = gl.createBuffer();   // corner(2) + size(1) + color(4) per vertex
    this._bufLinkPos = gl.createBuffer();
    this._bufLinkColor = gl.createBuffer();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // ---- simulation (mirrors the canvas renderer's physics) ----
    var d3 = window.d3;
    this._linkForce = d3.forceLink([]).id(function (d) { return d.id; }).distance(34);
    this.sim = d3.forceSimulation([])
      .force('link', this._linkForce)
      .force('charge', d3.forceManyBody().strength(-55))
      .force('center', d3.forceCenter(0, 0))
      .velocityDecay(0.4)
      .alphaDecay(1 - Math.pow(0.001, 1 / 200))
      .stop();
    var self = this;
    this.sim.on('tick', function () {
      self._posDirty = true;
      if (self._onTick) { try { self._onTick(); } catch (e) {} }
    });
    this.sim.on('end', function () {
      if (self._onStop) { try { self._onStop(); } catch (e) {} }
    });

    // ---- interactions: pan (drag) + zoom (wheel) + pinch ----
    this._onWheel = function (e) {
      e.preventDefault();
      var f = Math.pow(2, -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
      self._zoomAt(e.offsetX, e.offsetY, f);
    };
    this._onDown = function (e) {
      if (e.button !== 0) return;
      var sx = e.clientX, sy = e.clientY;
      var cx0 = self._cam.x, cy0 = self._cam.y;
      var mv = function (ev) {
        self._tween = null;
        self._cam.x = cx0 - (ev.clientX - sx) / self._cam.z;
        self._cam.y = cy0 - (ev.clientY - sy) / self._cam.z;
      };
      var up = function () {
        window.removeEventListener('mousemove', mv, true);
        window.removeEventListener('mouseup', up, true);
      };
      window.addEventListener('mousemove', mv, true);
      window.addEventListener('mouseup', up, true);
    };
    this._touch = null;
    this._onTouchStart = function (e) {
      if (e.touches.length === 1) {
        var t = e.touches[0];
        self._touch = { mode: 'pan', sx: t.clientX, sy: t.clientY, cx0: self._cam.x, cy0: self._cam.y };
      } else if (e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1];
        self._touch = { mode: 'pinch', d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z0: self._cam.z, mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2 };
      }
    };
    this._onTouchMove = function (e) {
      var t = self._touch; if (!t) return;
      e.preventDefault();
      self._tween = null;
      if (t.mode === 'pan' && e.touches.length === 1) {
        var p = e.touches[0];
        self._cam.x = t.cx0 - (p.clientX - t.sx) / self._cam.z;
        self._cam.y = t.cy0 - (p.clientY - t.sy) / self._cam.z;
      } else if (t.mode === 'pinch' && e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1];
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        var r = self.el.getBoundingClientRect();
        self._zoomTo(t.mx - r.left, t.my - r.top, t.z0 * (d / Math.max(1, t.d0)));
      }
    };
    this._onTouchEnd = function () { self._touch = null; };
    cv.addEventListener('wheel', this._onWheel, { passive: false });
    cv.addEventListener('mousedown', this._onDown);
    cv.addEventListener('touchstart', this._onTouchStart, { passive: true });
    cv.addEventListener('touchmove', this._onTouchMove, { passive: false });
    cv.addEventListener('touchend', this._onTouchEnd);

    this._resize();
    this._raf = requestAnimationFrame(this._frame.bind(this));
  }

  KGWebGLGraph.prototype = {
    // ───────────────────────────── force-graph API subset ────────────────────
    graphData: function (data) {
      if (data === undefined) return { nodes: this._nodes, links: this._links };
      this._nodes = data.nodes || [];
      this._links = data.links || [];
      this._visSet = {};
      for (var vi = 0; vi < this._nodes.length; vi++) this._visSet[this._nodes[vi].id] = 1;
      for (var i = 0; i < this._links.length; i++) this._links[i].__key = null;
      this.sim.nodes(this._nodes);
      this._linkForce.links(this._links);   // resolves string ids -> node refs
      this._allocBuffers();
      this._styleDirty = true;
      this._posDirty = true;
      this.sim.alpha(1).restart();
      return this;
    },
    d3ReheatSimulation: function () { this.sim.alpha(Math.max(this.sim.alpha(), 1)).restart(); return this; },
    onEngineTick: function (fn) { this._onTick = fn; return this; },
    onEngineStop: function (fn) { this._onStop = fn; return this; },
    width: function (w) { if (w === undefined) return this._w; this._w = w; this._resize(); return this; },
    height: function (h) { if (h === undefined) return this._h; this._h = h; this._resize(); return this; },
    zoom: function (z, ms) {
      if (z === undefined) return this._cam.z;
      if (ms) { this._startTween(this._cam.x, this._cam.y, z, ms); return this; }
      this._tweenField('z', z);
      return this;
    },
    centerAt: function (x, y, ms) {
      if (x === undefined) return { x: this._cam.x, y: this._cam.y };
      if (ms) { this._startTween(x, y, this._cam.z, ms); return this; }
      this._tweenField('xy', { x: x, y: y });
      return this;
    },
    zoomToFit: function (ms, pad) {
      var b = this._bbox(); if (!b) return this;
      pad = pad || 0;
      var z = Math.min(6, Math.min((this._w - pad * 2) / Math.max(1, b.w), (this._h - pad * 2) / Math.max(1, b.h)));
      this._startTween(b.cx, b.cy, Math.max(0.02, z), ms || 0);
      return this;
    },
    screen2GraphCoords: function (sx, sy) {
      return { x: this._cam.x + (sx - this._w / 2) / this._cam.z, y: this._cam.y + (sy - this._h / 2) / this._cam.z };
    },
    graph2ScreenCoords: function (gx, gy) {
      return { x: (gx - this._cam.x) * this._cam.z + this._w / 2, y: (gy - this._cam.y) * this._cam.z + this._h / 2 };
    },
    // style refresh hooks used by _kickGraph()
    linkColor: function (fn) { if (fn === undefined) return this._lcFn; this._lcFn = fn; this._styleDirty = true; return this; },
    linkWidth: function (fn) { if (fn === undefined) return this._lwFn; this._lwFn = fn; this._styleDirty = true; return this; },
    linkDirectionalParticleColor: function (fn) { if (fn === undefined) return this._lpcFn; this._lpcFn = fn; return this; },
    nodeRelSize: function (v) { if (v === undefined) return 4; this._styleDirty = true; return this; },
    _destructor: function () {
      this._dead = true;
      cancelAnimationFrame(this._raf);
      this.sim.stop();
      this.cv.removeEventListener('wheel', this._onWheel);
      this.cv.removeEventListener('mousedown', this._onDown);
      this.cv.removeEventListener('touchstart', this._onTouchStart);
      this.cv.removeEventListener('touchmove', this._onTouchMove);
      this.cv.removeEventListener('touchend', this._onTouchEnd);
      var lose = this.gl.getExtension('WEBGL_lose_context');
      if (lose) { try { lose.loseContext(); } catch (e) {} }
      if (this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
      if (this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
    },

    // ───────────────────────────── internals ────────────────────────────────
    _bbox: function () {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
      for (var i = 0; i < this._nodes.length; i++) {
        var n = this._nodes[i];
        if (n.x == null) continue;
        any = true;
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
      }
      if (!any) return null;
      return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: (maxX - minX) + 60, h: (maxY - minY) + 60 };
    },
    _zoomAt: function (px, py, f) { this._zoomTo(px, py, this._cam.z * f); },
    _zoomTo: function (px, py, z) {
      z = Math.max(0.02, Math.min(60, z));
      var g = this.screen2GraphCoords(px, py);
      this._tween = null;
      this._cam.z = z;
      this._cam.x = g.x - (px - this._w / 2) / z;
      this._cam.y = g.y - (py - this._h / 2) / z;
    },
    _tweenField: function (kind, v) {
      // instant set (used per-frame by the app's own animateView interpolation)
      this._tween = null;
      if (kind === 'z') this._cam.z = Math.max(0.02, Math.min(60, v));
      else { this._cam.x = v.x; this._cam.y = v.y; }
    },
    _startTween: function (x, y, z, ms) {
      if (!ms) { this._tween = null; this._cam.x = x; this._cam.y = y; this._cam.z = z; return; }
      this._tween = { t0: performance.now(), ms: ms, x0: this._cam.x, y0: this._cam.y, z0: this._cam.z, x1: x, y1: y, z1: z };
    },
    _resize: function () {
      var dpr = this._dpr;
      this.cv.width = Math.max(1, Math.round(this._w * dpr));
      this.cv.height = Math.max(1, Math.round(this._h * dpr));
      this.cv.style.width = this._w + 'px';
      this.cv.style.height = this._h + 'px';
      this.ov.width = this.cv.width;
      this.ov.height = this.cv.height;
      this.ov.style.width = this._w + 'px';
      this.ov.style.height = this._h + 'px';
      this.gl.viewport(0, 0, this.cv.width, this.cv.height);
    },
    _allocBuffers: function () {
      var gl = this.gl;
      var nv = this._nodes.length * 6;
      this._nodePos = new Float32Array(nv * 2);
      this._nodeStatic = new Float32Array(nv * 7);
      var lv = this._links.length * 2;
      this._linkPos = new Float32Array(lv * 2);
      this._linkColorArr = new Float32Array(lv * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodePos);
      gl.bufferData(gl.ARRAY_BUFFER, this._nodePos.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodeStatic);
      gl.bufferData(gl.ARRAY_BUFFER, this._nodeStatic.byteLength, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkPos);
      gl.bufferData(gl.ARRAY_BUFFER, this._linkPos.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkColor);
      gl.bufferData(gl.ARRAY_BUFFER, this._linkColorArr.byteLength, gl.STATIC_DRAW);
    },
    _computeStyleSig: function () {
      var c = this.comp, s = c.state || {};
      var fg = c._focusGroups ? c._focusGroups.size : 0;
      var q = '';
      try { q = (c._activeQuery && c._activeQuery()) || ''; } catch (e) {}
      return [s.nodeColorMode, s.nodeSizeMul, s.nodeSizeByDegree !== false, s.edgeWidthMul, s.wikiEdgeColor, s.treeEdgeColor,
        q, s.searchFocus, fg, c.actingRoot, c.rootId,
        c.activeAnchorId ? c.activeAnchorId() : null,
        c.highlightLinkSet ? c.highlightLinkSet.size : 0,
        c.pathLinkSet ? c.pathLinkSet.size : 0,
        c._edgeOther].join('|');
    },
    _rebuildStyles: function () {
      var c = this.comp, gl = this.gl;
      var i, n, j, base;
      var rootId = (c.actingRoot != null ? c.actingRoot : c.rootId);
      for (i = 0; i < this._nodes.length; i++) {
        n = this._nodes[i];
        var fill = (n.id === rootId) ? c.ROOT_COLOR : (c.isAnchored(n.id) ? c.ANCHOR_COLOR : c.color(n));
        var col = parseColor(fill);
        var alpha = 1;
        try { if (c._dimAlpha(n) < 1) alpha = 0.14; } catch (e) {}
        var size = c.nodeRadius(n);
        for (j = 0; j < 6; j++) {
          base = (i * 6 + j) * 7;
          this._nodeStatic[base] = QUAD[j][0];
          this._nodeStatic[base + 1] = QUAD[j][1];
          this._nodeStatic[base + 2] = size;
          this._nodeStatic[base + 3] = col[0];
          this._nodeStatic[base + 4] = col[1];
          this._nodeStatic[base + 5] = col[2];
          this._nodeStatic[base + 6] = alpha * col[3];
        }
      }
      for (i = 0; i < this._links.length; i++) {
        var l = this._links[i];
        var lc = parseColor(this._lcFn ? this._lcFn(l) : c.linkColorFn(l));
        for (j = 0; j < 2; j++) {
          base = (i * 2 + j) * 4;
          this._linkColorArr[base] = lc[0];
          this._linkColorArr[base + 1] = lc[1];
          this._linkColorArr[base + 2] = lc[2];
          this._linkColorArr[base + 3] = lc[3];
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodeStatic);
      gl.bufferData(gl.ARRAY_BUFFER, this._nodeStatic, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkColor);
      gl.bufferData(gl.ARRAY_BUFFER, this._linkColorArr, gl.STATIC_DRAW);
    },
    _uploadPositions: function () {
      var gl = this.gl, i, j, n, base;
      for (i = 0; i < this._nodes.length; i++) {
        n = this._nodes[i];
        var x = n.x || 0, y = n.y || 0;
        for (j = 0; j < 6; j++) {
          base = (i * 6 + j) * 2;
          this._nodePos[base] = x;
          this._nodePos[base + 1] = y;
        }
      }
      for (i = 0; i < this._links.length; i++) {
        var l = this._links[i];
        var s = l.source, t = l.target;
        base = i * 4;
        this._linkPos[base] = (s && s.x) || 0;
        this._linkPos[base + 1] = (s && s.y) || 0;
        this._linkPos[base + 2] = (t && t.x) || 0;
        this._linkPos[base + 3] = (t && t.y) || 0;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodePos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._nodePos);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkPos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._linkPos);
    },
    _frame: function () {
      if (this._dead) return;
      this._raf = requestAnimationFrame(this._frame.bind(this));
      // camera tween
      var tw = this._tween;
      if (tw) {
        var p = Math.min(1, (performance.now() - tw.t0) / tw.ms);
        var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        this._cam.x = tw.x0 + (tw.x1 - tw.x0) * e;
        this._cam.y = tw.y0 + (tw.y1 - tw.y0) * e;
        this._cam.z = tw.z0 + (tw.z1 - tw.z0) * e;
        if (p >= 1) this._tween = null;
      }
      var sig = this._computeStyleSig();
      if (sig !== this._styleSig) { this._styleSig = sig; this._styleDirty = true; }
      if (this._styleDirty) { this._styleDirty = false; try { this._rebuildStyles(); } catch (e) {} }
      if (this._posDirty) { this._posDirty = false; this._uploadPositions(); }
      this._drawGL();
      this._drawOverlay();
    },
    _drawGL: function () {
      var gl = this.gl, L;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      var vw = this._w, vh = this._h;
      // links first (under nodes)
      if (this._links.length) {
        L = this._loc.l;
        gl.useProgram(this._pLink);
        gl.uniform2f(L.uCenter, this._cam.x, this._cam.y);
        gl.uniform1f(L.uZoom, this._cam.z);
        gl.uniform2f(L.uViewport, vw, vh);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkPos);
        gl.enableVertexAttribArray(L.aPos);
        gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufLinkColor);
        gl.enableVertexAttribArray(L.aColor);
        gl.vertexAttribPointer(L.aColor, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, this._links.length * 2);
      }
      if (this._nodes.length) {
        L = this._loc.n;
        gl.useProgram(this._pNode);
        gl.uniform2f(L.uCenter, this._cam.x, this._cam.y);
        gl.uniform1f(L.uZoom, this._cam.z);
        gl.uniform2f(L.uViewport, vw, vh);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodePos);
        gl.enableVertexAttribArray(L.aPos);
        gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufNodeStatic);
        gl.enableVertexAttribArray(L.aCorner);
        gl.vertexAttribPointer(L.aCorner, 2, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(L.aSize);
        gl.vertexAttribPointer(L.aSize, 1, gl.FLOAT, false, 28, 8);
        gl.enableVertexAttribArray(L.aColor);
        gl.vertexAttribPointer(L.aColor, 4, gl.FLOAT, false, 28, 12);
        gl.drawArrays(gl.TRIANGLES, 0, this._nodes.length * 6);
      }
    },
    _drawOverlay: function () {
      var c = this.comp, ctx = this.octx;
      var dpr = this._dpr, z = this._cam.z;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.ov.width, this.ov.height);
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this._w / 2 - this._cam.x * z), dpr * (this._h / 2 - this._cam.y * z));

      // hot edges (hover / anchor / path) — few, drawn thick over the GL layer
      var hasHot = (c.highlightLinkSet && c.highlightLinkSet.size) || (c.pathLinkSet && c.pathLinkSet.size) || c._edgeOther;
      if (hasHot) {
        var mul = (c.state && c.state.edgeWidthMul) || 1;
        for (var i = 0; i < this._links.length; i++) {
          var l = this._links[i];
          var hov = c.isEdgeHovered(l), ph = c.isPathHot(l), hot = c.isHot(l);
          if (!hov && !ph && !hot) continue;
          var s = l.source, t = l.target;
          if (!s || !t || s.x == null || t.x == null) continue;
          ctx.strokeStyle = c.linkColorFn(l);
          ctx.lineWidth = (hov ? 3.5 : (ph ? 4 : 0.8)) * mul;
          if (l.type === 'wiki') ctx.setLineDash([2, 2.5]); else ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // hero nodes get the full canvas-renderer treatment (root emblem, pulses, glow, labels)
      var rootId = (c.actingRoot != null ? c.actingRoot : c.rootId);
      var heroIds = [rootId, c.rootId, c.activeAnchorId ? c.activeAnchorId() : null, c.selectedId, c.hoverId, c.glowNodeId];
      var seen = {};
      var sv = c._visNodes;
      c._visNodes = 0;   // force draw2d's full (non-LOD) branch for heroes
      for (var h = 0; h < heroIds.length; h++) {
        var id = heroIds[h];
        if (id == null || seen[id]) continue;
        seen[id] = 1;
        var n = c.nodeById && c.nodeById[id];
        if (!n || n.x == null) continue;
        if (!this._visSet || !this._visSet[id]) continue;
        try { c.draw2d(n, ctx, z); } catch (e) {}
      }
      c._visNodes = sv;

      // labels (viewport-culled, capped)
      var pad = 40 / z;
      var x0 = this._cam.x - this._w / (2 * z) - pad, x1 = this._cam.x + this._w / (2 * z) + pad;
      var y0 = this._cam.y - this._h / (2 * z) - pad, y1 = this._cam.y + this._h / (2 * z) + pad;
      var fs = Math.min(6.5, Math.max(3, 11 / z));
      ctx.font = '500 ' + fs + "px 'JetBrains Mono', monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var drawn = 0;
      for (var m = 0; m < this._nodes.length && drawn < 250; m++) {
        var nd = this._nodes[m];
        if (nd.x == null || nd.x < x0 || nd.x > x1 || nd.y < y0 || nd.y > y1) continue;
        if (seen[nd.id]) continue;
        var d = nd.depth || 0;
        if (!(d <= 1 || (d === 2 && z > 1.4) || z > 2.1)) continue;
        var dim = 1;
        try { dim = c._dimAlpha(nd); } catch (e) {}
        if (dim < 1) continue;
        var name = nd.name || nd.title || '';
        var label = name.length > 24 ? name.slice(0, 23) + '…' : name;
        ctx.shadowColor = '#0f0c09';
        ctx.shadowBlur = 5;
        ctx.fillStyle = '#bdae93';
        ctx.fillText(label, nd.x, nd.y + c.nodeRadius(nd) + 3);
        drawn++;
      }
      ctx.shadowBlur = 0;
    },
  };

  window.KGWebGLGraph = KGWebGLGraph;
})();
