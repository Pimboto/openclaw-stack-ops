/* ============================================================
   slot-text · in-house reimplementation (zero deps, classic script)
   Exposes window.slotText(element, text, options?) → controller.

   Dependency-free roll/slot animation for tiny tactile UI labels:
   per-character spans, pure CSS transforms (translateY + opacity),
   staggered per char. The final text stays accessible (the container
   carries an aria-label and the visible glyphs are real text).

   Reimplements the API + feel of the `slot-text` npm package — the
   package is NOT installed (project rule: vanilla, no npm/build).

     const c = slotText(el, 'LIVE');
     c.set('RECONECTANDO', { direction: 'up', color: 'var(--amber)' });
     c.flash('OK', { color: 'var(--cyan)' });   // always re-rolls, even if unchanged
     c.destroy();

   INVARIANT: after ANY sequence of set/flash/interruptions, every cell holds
   exactly the expected children — one settled .st-char per cell once the roll
   finishes (plus a transient .st-exit twin only WHILE a cell is mid-roll) — and
   the container's flat textContent === the most recent value passed to set().
   An interrupting set() enforces this by normalizing each cell back to a single
   `current` char (killing this animation's timers) BEFORE mounting the new roll,
   so a stranded incoming span can never accumulate across interruptions.
   ============================================================ */
(function () {
  'use strict';

  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // keep reduced-motion preference live (set instantly, no rolls/stagger)
  try {
    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(function (e) { RM = e.matches; });
  } catch (e) { /* older browsers: static RM is fine */ }

  var STYLE_ID = 'slot-text-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.slot-text{display:inline-flex;white-space:pre;align-items:baseline}',
      '.slot-text .st-cell{position:relative;display:inline-block;text-align:center}',
      '.slot-text .st-char{display:inline-block;will-change:transform,opacity}',
      '.slot-text .st-char.st-exit{position:absolute;left:0;top:0;width:100%}'
    ].join('');
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  var DEFAULTS = {
    direction: 'down',       // 'up' | 'down'
    stagger: 45,             // ms between characters
    duration: 300,           // ms per character roll
    exitOffset: 50,          // travel distance, in % of one em (50 → 0.5em)
    easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    bounce: 0.6,             // accepted for API parity (encoded in the easing)
    color: null,             // string | (index, total) => string — tints incoming chars
    colorFade: 280,          // accepted for API parity
    skipUnchanged: true,     // unchanged chars don't re-animate
    interrupt: true          // a new set() cancels the in-flight animation
  };

  function merge(base, over) {
    var o = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k) && over[k] !== undefined) o[k] = over[k];
    return o;
  }

  function makeChar(ch, color) {
    var s = document.createElement('span');
    s.className = 'st-char';
    s.textContent = ch;
    if (color) s.style.color = color;
    return s;
  }
  function makeCell(ch) {
    var c = document.createElement('span');
    c.className = 'st-cell';
    c.appendChild(makeChar(ch, null));
    return c;
  }

  function slotText(element, text, options) {
    if (!element) throw new Error('slotText: element required');
    injectStyle();
    element.classList.add('slot-text');

    var opts = merge(DEFAULTS, options);
    var current = '';
    var timers = [];
    var token = 0; // bumps on every set → stale callbacks bail out

    function clearTimers() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
    }

    function renderInstant(str) {
      clearTimers();
      element.textContent = '';
      for (var i = 0; i < str.length; i++) element.appendChild(makeCell(str[i]));
      element.setAttribute('aria-label', str);
      current = str;
    }

    function colorFor(o, i, total) {
      if (o.color == null) return null;
      return (typeof o.color === 'function') ? o.color(i, total) : o.color;
    }

    function set(str, override) {
      str = String(str == null ? '' : str);
      var o = merge(opts, override);
      // always reflect the logical value for assistive tech
      element.setAttribute('aria-label', str);
      if (o.skipUnchanged && str === current) return controller;
      if (RM) { renderInstant(str); return controller; }

      var old = current;
      if (o.interrupt) {
        // Kill the in-flight roll AND normalize the DOM: collapse every existing
        // cell to a single .st-char holding its settled `old` char, discarding
        // any stranded incoming/outgoing spans a prior interruption left behind
        // (both the firstChild outgoing twin AND the second incoming child).
        // Without this, each interruption orphans the entering span → one extra
        // child piles up per cell on churn (e.g. LIVE→RECONECTANDO→LIVE, or two
        // synchronous set()s in one batch). Restores the 1-child-per-cell
        // invariant before the new transition mounts.
        clearTimers();
        for (var c = element.children.length - 1; c >= 0; c--) {
          var cellC = element.children[c];
          if (c < old.length) {
            cellC.textContent = '';
            cellC.appendChild(makeChar(old[c], null));
          } else {
            element.removeChild(cellC); // transient growth past `old` — drop it
          }
        }
      }
      var n = Math.max(old.length, str.length);
      var offset = (o.exitOffset / 100) + 'em';
      // direction defines a consistent flow: 'down' rolls top→bottom, 'up' bottom→top
      var enterFrom = o.direction === 'up' ? offset : '-' + offset;   // where the new char starts
      var exitTo = o.direction === 'up' ? '-' + offset : offset;      // where the old char leaves
      var trans = 'transform ' + o.duration + 'ms ' + o.easing + ', opacity ' + Math.round(o.duration * 0.6) + 'ms linear';
      var myToken = ++token;

      // grow the cell row to the max length up front
      while (element.children.length < n) element.appendChild(makeCell(''));

      var maxDelay = 0;
      for (var i = 0; i < n; i++) {
        var oldCh = old[i] || '';
        var newCh = str[i] || '';
        var cell = element.children[i];
        if (o.skipUnchanged && oldCh === newCh) continue;

        var delay = i * o.stagger;
        if (delay > maxDelay) maxDelay = delay;

        var exiting = cell.firstChild; // the currently shown char (may be empty '')
        var fresh = makeChar(newCh, colorFor(o, i, n));
        fresh.style.transition = 'none';
        fresh.style.transform = 'translateY(' + enterFrom + ')';
        fresh.style.opacity = '0';
        if (exiting) exiting.classList.add('st-exit');
        cell.appendChild(fresh);
        void cell.offsetWidth; // force reflow so the initial state sticks

        (function (exitNode, freshNode, cellNode, d) {
          var t = setTimeout(function () {
            if (myToken !== token) return; // superseded by a newer set()
            freshNode.style.transition = trans;
            freshNode.style.transform = 'translateY(0)';
            freshNode.style.opacity = '1';
            if (exitNode) {
              exitNode.style.transition = trans;
              exitNode.style.transform = 'translateY(' + exitTo + ')';
              exitNode.style.opacity = '0';
              var rm = setTimeout(function () {
                if (exitNode.parentNode === cellNode) cellNode.removeChild(exitNode);
              }, o.duration + 40);
              timers.push(rm);
            }
          }, d);
          timers.push(t);
        })(exiting, fresh, cell, delay);
      }

      // after the last char settles, drop any cells past the new length
      var cleanup = setTimeout(function () {
        if (myToken !== token) return;
        while (element.children.length > str.length) element.removeChild(element.lastChild);
      }, maxDelay + o.duration + 60);
      timers.push(cleanup);

      current = str;
      return controller;
    }

    function flash(str, override) {
      // a flash is an attention pulse: it must roll even when the text is
      // unchanged, so force skipUnchanged:false regardless of the caller/opts.
      var o = merge(override || {}, { skipUnchanged: false });
      if (o.color == null) o.color = 'var(--amber)';
      return set(str, o);
    }

    function destroy() {
      clearTimers();
      token++;
      element.textContent = current;
      element.removeAttribute('aria-label');
      element.classList.remove('slot-text');
    }

    var controller = { set: set, flash: flash, destroy: destroy };
    // initial paint (instant — this IS the first value)
    renderInstant(String(text == null ? '' : text));
    return controller;
  }

  window.slotText = slotText;
})();
