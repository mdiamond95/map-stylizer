// Pan and zoom image viewer with an SVG overlay in image pixel space.
// Works with touch (one finger pans, two pinch), Apple Pencil, mouse and trackpad.
// In draw mode one finger draws instead (onDraw), and two still pan and pinch.

export class ImageViewer {
  constructor(el, { onTap, onPinMove, onDraw } = {}) {
    this.el = el;
    this.onTap = onTap;
    this.onPinMove = onPinMove;
    this.onDraw = onDraw;
    this.drawMode = false;
    this.brushSize = 0;
    el.classList.add('viewer');
    el.innerHTML = `<div class="stage"><img alt="" draggable="false"><svg class="overlay" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="pins"></div><div class="brush" hidden></div><div class="viewer-empty">Open a map image to start</div>`;
    this.stage = el.querySelector('.stage');
    this.img = el.querySelector('img');
    this.overlay = el.querySelector('svg');
    this.pinLayer = el.querySelector('.pins');
    this.empty = el.querySelector('.viewer-empty');
    this.brush = el.querySelector('.brush');
    this.t = { x: 0, y: 0, k: 1 };
    this.pins = [];
    this.pointers = new Map();
    this.bind();
    new ResizeObserver(() => { if (this.w && !this.userMoved) this.fit(); }).observe(el);
  }

  setImage(src, w, h) {
    this.w = w; this.h = h;
    this.img.src = src || '';
    this.img.style.width = `${w}px`;
    this.img.style.height = `${h}px`;
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.empty.hidden = !!src;
    this.userMoved = false;
    this.fit();
  }

  // Draw mode, with a round brush outline of `size` screen pixels (0 for none).
  setDrawMode(on, size = 0) {
    this.drawMode = on;
    this.brushSize = size;
    this.brush.style.width = this.brush.style.height = `${size}px`;
    if (!on) this.brush.hidden = true;
  }

  showBrush(clientX, clientY) {
    if (!this.drawMode || !this.brushSize) return;
    const r = this.el.getBoundingClientRect();
    this.brush.style.left = `${clientX - r.left}px`;
    this.brush.style.top = `${clientY - r.top}px`;
    this.brush.hidden = false;
  }

  setImageOpacity(v) { this.img.style.opacity = v; }
  setOverlay(markup) { this.overlay.innerHTML = markup; }
  setOverlayOpacity(v) { this.overlay.style.opacity = v; }

  fit() {
    if (!this.w) return;
    const r = this.el.getBoundingClientRect();
    const k = Math.min(r.width / this.w, r.height / this.h) * 0.96;
    this.t = { k, x: (r.width - this.w * k) / 2, y: (r.height - this.h * k) / 2 };
    this.apply();
  }

  // pins: [{ id, x, y, label, state, selected }]
  setPins(pins) { this.pins = pins; this.renderPins(); }

  toImage(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.t.x) / this.t.k, (clientY - r.top - this.t.y) / this.t.k];
  }

  apply() {
    this.stage.style.transform = `translate(${this.t.x}px, ${this.t.y}px) scale(${this.t.k})`;
    // Keep overlay lines a constant on-screen width at any zoom.
    this.overlay.style.setProperty('--px', `${1 / this.t.k}`);
    this.renderPins();
  }

  renderPins() {
    this.pinLayer.innerHTML = '';
    for (const p of this.pins) {
      const d = document.createElement('div');
      d.className = `pin ${p.state || ''} ${p.selected ? 'selected' : ''}`;
      d.style.left = `${p.x * this.t.k + this.t.x}px`;
      d.style.top = `${p.y * this.t.k + this.t.y}px`;
      d.textContent = p.label ?? '';
      d.dataset.id = p.id;
      this.pinLayer.appendChild(d);
    }
  }

  zoomAt(cx, cy, factor) {
    const r = this.el.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const k = Math.max(0.02, Math.min(40, this.t.k * factor));
    const f = k / this.t.k;
    this.t = { k, x: px - (px - this.t.x) * f, y: py - (py - this.t.y) * f };
    this.userMoved = true;
    this.apply();
  }

  bind() {
    const el = this.el;
    let start = null, pinch = null, dragPin = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinEl = e.target.closest('.pin');
      if (pinEl && this.pointers.size === 1 && this.onPinMove) {
        dragPin = { id: pinEl.dataset.id, moved: false };
        return;
      }
      if (this.pointers.size === 1) {
        start = { x: e.clientX, y: e.clientY, tx: this.t.x, ty: this.t.y, moved: false, target: e.target, draw: this.drawMode && !!this.onDraw };
        this.showBrush(e.clientX, e.clientY);
      }
      if (this.pointers.size === 2) {
        // A second finger means pan and pinch, not drawing.
        if (start?.draw && start.moved) this.onDraw('cancel');
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k: this.t.k, tx: this.t.x, ty: this.t.y };
        start = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.pointers.size < 2) this.showBrush(e.clientX, e.clientY);
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (dragPin) {
        const [x, y] = this.toImage(e.clientX, e.clientY);
        const p = this.pins.find((q) => String(q.id) === dragPin.id);
        if (p) { p.x = x; p.y = y; dragPin.moved = true; this.renderPins(); }
        return;
      }
      if (pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = el.getBoundingClientRect();
        const k = Math.max(0.02, Math.min(40, pinch.k * d / pinch.d));
        const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        const ox = pinch.cx - r.left, oy = pinch.cy - r.top;
        const f = k / pinch.k;
        this.t = { k, x: cx - (ox - pinch.tx) * f, y: cy - (oy - pinch.ty) * f };
        this.userMoved = true;
        this.apply();
      } else if (start?.draw) {
        if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) {
          start.moved = true;
          this.onDraw('start', this.toImage(start.x, start.y));
        }
        if (start.moved) this.onDraw('move', this.toImage(e.clientX, e.clientY));
      } else if (start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 6) start.moved = true;
        if (start.moved) { this.t.x = start.tx + dx; this.t.y = start.ty + dy; this.userMoved = true; this.apply(); }
      }
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (dragPin) {
        if (dragPin.moved) {
          const p = this.pins.find((q) => String(q.id) === dragPin.id);
          this.onPinMove?.(dragPin.id, [p.x, p.y]);
        } else {
          this.onTap?.(null, { pinId: dragPin.id });
        }
        dragPin = null;
        return;
      }
      if (start?.draw && start.moved) this.onDraw(e.type === 'pointerup' ? 'end' : 'cancel');
      if (e.pointerType !== 'mouse') this.brush.hidden = true;
      if (start && !start.moved && e.type === 'pointerup' && this.w) {
        this.onTap?.(this.toImage(e.clientX, e.clientY), { target: start.target });
      }
      start = null;
      if (this.pointers.size < 2) pinch = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!this.pointers.size) this.brush.hidden = true; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || !e.deltaX) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { this.t.x -= e.deltaX; this.t.y -= e.deltaY; this.apply(); }
    }, { passive: false });
    el.addEventListener('dblclick', (e) => this.zoomAt(e.clientX, e.clientY, 2));
  }
}
