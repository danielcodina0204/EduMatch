(function () {
    'use strict';

    const ICONS = {
        chevron: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        calendar: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 8.5h14M7 3v3M13 3v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        clock: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4.2l2.8 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        prev: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12.5 4.5l-5 5.5 5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        next: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M7.5 4.5l5 5.5-5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };
    const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
    const pad = n => String(n).padStart(2, '0');

    function el(tag, props = {}, html) {
        const node = document.createElement(tag);
        Object.entries(props).forEach(([k, v]) => { if (v === true) node.setAttribute(k, ''); else if (v !== false && v != null) node.setAttribute(k, v); });
        if (html != null) node.innerHTML = html;
        return node;
    }

    const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const todayIso = () => { const t = new Date(); return isoOf(t.getFullYear(), t.getMonth(), t.getDate()); };
    const parseIso = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
    const formatIso = s => { const p = parseIso(s); return p ? `${pad(p.d)}/${pad(p.m + 1)}/${p.y}` : ''; };

    let openPanel = null; // { close(), contains(node) }
    function closeOpenPanel() { if (openPanel) openPanel.close(false); }

    document.addEventListener('pointerdown', event => {
        if (openPanel && !openPanel.contains(event.target)) openPanel.close(false);
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && openPanel) { event.stopPropagation(); openPanel.close(true); }
    }, true);
    window.addEventListener('resize', () => { if (openPanel && !document.documentElement.classList.contains('kb-open')) openPanel.close(false); });

    function placePanel(field, trigger, panel, { constrain = false, maxHeight = 280 } = {}) {
        field.classList.remove('is-up');
        panel.style.maxHeight = '';
        const nav = document.querySelector('.nav-links');
        const navStyle = nav ? getComputedStyle(nav) : null;
        const bottomLimit = nav && navStyle.position === 'fixed' && navStyle.display !== 'none' ? nav.getBoundingClientRect().top : window.innerHeight;
        const header = document.querySelector('.navbar');
        const topLimit = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        const r = trigger.getBoundingClientRect();
        const below = bottomLimit - r.bottom - 10;
        const above = r.top - topLimit - 10;
        const need = Math.min(panel.scrollHeight + 4, constrain ? maxHeight : 9999);
        const up = below < need && above > below;
        field.classList.toggle('is-up', up);
        if (constrain) panel.style.maxHeight = Math.max(120, Math.min(maxHeight, up ? above : below)) + 'px';
        const pr = panel.getBoundingClientRect();
        if (!up && pr.bottom > bottomLimit - 6) window.scrollBy({ top: pr.bottom - bottomLimit + 10, behavior: 'smooth' });
        else if (up && pr.top < topLimit + 6) window.scrollBy({ top: pr.top - topLimit - 10, behavior: 'smooth' });
    }

    function wrapNative(native, kind) {
        const field = el('div', { class: `ui-field ui-field--${kind}` });
        native.parentNode.insertBefore(field, native);
        field.appendChild(native);
        native.classList.add('ui-native');
        native.setAttribute('tabindex', '-1');
        native.setAttribute('aria-hidden', 'true');
        native.dataset.ui = kind;
        return field;
    }

    function watchValue(native, refresh, proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        Object.defineProperty(native, 'value', {
            configurable: true,
            get() { return desc.get.call(this); },
            set(v) { desc.set.call(this, v); refresh(); }
        });
        if (native.tagName === 'SELECT') {
            const idx = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
            Object.defineProperty(native, 'selectedIndex', {
                configurable: true,
                get() { return idx.get.call(this); },
                set(v) { idx.set.call(this, v); refresh(); }
            });
        }
        const form = native.form;
        if (form) form.addEventListener('reset', () => setTimeout(refresh, 0));
    }

    function commit(native, value) {
        const proto = native.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(native, value); // sin doble refresco
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function labelFor(native) {
        const own = native.getAttribute('aria-label');
        if (own) return own;
        const lbl = native.id ? document.querySelector(`label[for="${native.id}"]`) : null;
        return lbl ? lbl.textContent.replace(/\(opcional\)/i, '').trim() : '';
    }

    function makeTrigger(native, iconSvg) {
        const trigger = el('button', { type: 'button', class: 'ui-trigger', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
        trigger.innerHTML = `${iconSvg ? `<span class="ui-trigger__icon">${iconSvg}</span>` : ''}<span class="ui-trigger__label"></span><span class="ui-trigger__chevron">${ICONS.chevron}</span>`;
        native.addEventListener('focus', () => trigger.focus({ preventScroll: true }));
        if (native.id) {
            const label = document.querySelector(`label[for="${native.id}"]`);
            if (label) label.addEventListener('click', event => { event.preventDefault(); trigger.click(); });
        }
        return trigger;
    }

    function enhanceSelect(sel) {
        if (sel.multiple || sel.size > 1) return;
        const field = wrapNative(sel, 'select');
        const trigger = makeTrigger(sel, '');
        const menu = el('ul', { class: 'ui-menu ui-list', role: 'listbox', tabindex: '-1', hidden: true });
        field.append(trigger, menu);
        const labelEl = trigger.querySelector('.ui-trigger__label');
        const caption = labelFor(sel);
        let active = -1;

        function refresh() {
            const o = sel.options[sel.selectedIndex];
            labelEl.textContent = o ? o.textContent.trim() : '';
            trigger.classList.toggle('is-placeholder', !o || o.value === '');
            trigger.disabled = sel.disabled;
            field.classList.toggle('is-disabled', sel.disabled);
            trigger.setAttribute('aria-label', `${caption ? caption + ': ' : ''}${labelEl.textContent}`);
        }

        function build() {
            menu.innerHTML = '';
            [...sel.options].forEach((o, i) => {
                const li = el('li', { class: 'ui-option', role: 'option', 'data-index': i });
                li.textContent = o.textContent.trim();
                if (o.value === '') li.classList.add('is-placeholder');
                if (o.disabled) li.setAttribute('aria-disabled', 'true');
                if (i === sel.selectedIndex) { li.classList.add('is-selected'); li.setAttribute('aria-selected', 'true'); }
                menu.appendChild(li);
            });
        }

        function setActive(i, scroll = true) {
            const items = menu.children;
            if (!items.length) return;
            active = Math.max(0, Math.min(items.length - 1, i));
            [...items].forEach((li, k) => li.classList.toggle('is-active', k === active));
            if (scroll) items[active].scrollIntoView({ block: 'nearest' });
        }

        function choose(i) {
            const o = sel.options[i];
            if (!o || o.disabled) return;
            close(true);
            if (i !== sel.selectedIndex) commit(sel, o.value);
            refresh();
        }

        function open() {
            if (sel.disabled || !sel.options.length) return;
            closeOpenPanel();
            build();
            menu.hidden = false;
            field.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
            placePanel(field, trigger, menu, { constrain: true, maxHeight: 280 });
            setActive(Math.max(0, sel.selectedIndex));
            menu.focus({ preventScroll: true });
            openPanel = { close, contains: n => field.contains(n) };
        }

        function close(focusTrigger) {
            menu.hidden = true;
            field.classList.remove('is-open', 'is-up');
            trigger.setAttribute('aria-expanded', 'false');
            if (openPanel && openPanel.contains(menu)) openPanel = null;
            if (focusTrigger) trigger.focus({ preventScroll: true });
        }

        trigger.addEventListener('click', () => (menu.hidden ? open() : close(true)));
        trigger.addEventListener('keydown', e => {
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); if (menu.hidden) open(); }
        });
        menu.addEventListener('click', e => { const li = e.target.closest('.ui-option'); if (li) choose(+li.dataset.index); });
        menu.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
            else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
            else if (e.key === 'End') { e.preventDefault(); setActive(menu.children.length - 1); }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
            else if (e.key === 'Tab') close(false);
        });

        watchValue(sel, refresh, HTMLSelectElement.prototype);
        sel.addEventListener('change', refresh);
        new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
        refresh();
    }

    function createSharedDialog(panelClass, ariaLabel) {
        const backdrop = el('div', { class: 'ui-popover-backdrop', hidden: true });
        const panel = el('div', { class: `ui-menu ui-popover ${panelClass}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': ariaLabel, hidden: true });
        document.body.append(backdrop, panel);
        let activeField = null;
        let activeTrigger = null;
        let onClick = null;

        function close(focusTrigger) {
            backdrop.hidden = true;
            panel.hidden = true;
            if (activeField) activeField.classList.remove('is-open');
            if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
            if (openPanel && openPanel.contains(panel)) openPanel = null;
            const trigger = activeTrigger;
            activeField = activeTrigger = onClick = null;
            if (focusTrigger && trigger) trigger.focus({ preventScroll: true });
        }

        function open(field, trigger, fill, handleClick) {
            closeOpenPanel();
            activeField = field;
            activeTrigger = trigger;
            onClick = handleClick;
            fill();
            backdrop.hidden = false;
            panel.hidden = false;
            field.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
            openPanel = { close, contains: n => panel.contains(n) || backdrop.contains(n) || trigger.contains(n) };
        }

        backdrop.addEventListener('click', () => close(false));
        panel.addEventListener('click', e => { if (onClick) onClick(e); });

        return { panel, open, close, isOpenFor: field => !panel.hidden && activeField === field };
    }

    const calendarDialog = createSharedDialog('ui-cal', 'Elegir fecha');
    const timeDialog = createSharedDialog('ui-time', 'Elegir hora');

    function enhanceDate(inp) {
        const field = wrapNative(inp, 'date');
        const trigger = makeTrigger(inp, ICONS.calendar);
        field.appendChild(trigger);
        const labelEl = trigger.querySelector('.ui-trigger__label');
        const caption = labelFor(inp);
        let viewY, viewM;

        function refresh() {
            const has = !!parseIso(inp.value);
            labelEl.textContent = has ? formatIso(inp.value) : 'Elige la fecha';
            trigger.classList.toggle('is-placeholder', !has);
            trigger.setAttribute('aria-label', `${caption ? caption + ': ' : ''}${has ? formatIso(inp.value) : 'sin elegir'}`);
        }

        function render() {
            const min = inp.min || '', max = inp.max || '', sel = inp.value, today = todayIso();
            const first = (new Date(viewY, viewM, 1).getDay() + 6) % 7; // semana desde lunes
            const days = new Date(viewY, viewM + 1, 0).getDate();
            const prevOk = !min || isoOf(viewY, viewM, 1) > min;
            const nextOk = !max || isoOf(viewY, viewM, days) < max;
            let cells = '';
            for (let i = 0; i < first; i++) cells += '<span class="ui-cal__blank"></span>';
            for (let d = 1; d <= days; d++) {
                const iso = isoOf(viewY, viewM, d);
                const off = (min && iso < min) || (max && iso > max);
                cells += `<button type="button" class="ui-cal__day${iso === sel ? ' is-selected' : ''}${iso === today ? ' is-today' : ''}" data-date="${iso}"${off ? ' disabled' : ''}>${d}</button>`;
            }
            const todayOk = (!min || today >= min) && (!max || today <= max);
            calendarDialog.panel.innerHTML = `
                <div class="ui-cal__head">
                    <button type="button" class="ui-cal__nav" data-nav="-1" aria-label="Mes anterior"${prevOk ? '' : ' disabled'}>${ICONS.prev}</button>
                    <span class="ui-cal__title">${MONTHS[viewM]} ${viewY}</span>
                    <button type="button" class="ui-cal__nav" data-nav="1" aria-label="Mes siguiente"${nextOk ? '' : ' disabled'}>${ICONS.next}</button>
                    <button type="button" class="ui-popover__close" data-close aria-label="Cerrar">&times;</button>
                </div>
                <div class="ui-cal__body">
                    <div class="ui-cal__week">${WEEKDAYS.map(w => `<span>${w}</span>`).join('')}</div>
                    <div class="ui-cal__grid">${cells}</div>
                    <div class="ui-cal__foot"><button type="button" class="ui-link" data-today${todayOk ? '' : ' disabled'}>Hoy</button></div>
                </div>`;
        }

        function handleClick(e) {
            if (e.target.closest('[data-close]')) { calendarDialog.close(true); return; }
            const nav = e.target.closest('[data-nav]');
            if (nav) { viewM += +nav.dataset.nav; if (viewM < 0) { viewM = 11; viewY--; } if (viewM > 11) { viewM = 0; viewY++; } render(); return; }
            const day = e.target.closest('[data-date]');
            const today = e.target.closest('[data-today]');
            const value = day ? day.dataset.date : today && !today.disabled ? todayIso() : null;
            if (value) { commit(inp, value); refresh(); calendarDialog.close(true); }
        }

        trigger.addEventListener('click', () => {
            if (calendarDialog.isOpenFor(field)) { calendarDialog.close(true); return; }
            const base = parseIso(inp.value) || parseIso(inp.min) || parseIso(todayIso());
            viewY = base.y; viewM = base.m;
            calendarDialog.open(field, trigger, render, handleClick);
        });

        watchValue(inp, refresh, HTMLInputElement.prototype);
        inp.addEventListener('change', refresh);
        inp.addEventListener('input', refresh);
        refresh();
    }

    const HOURS12 = Array.from({ length: 12 }, (_, i) => pad(i + 1)); // 01..12
    const MINUTES5 = Array.from({ length: 12 }, (_, i) => pad(i * 5)); // 00,05,…,55

    function enhanceTime(inp) {
        const field = wrapNative(inp, 'time');
        const trigger = makeTrigger(inp, ICONS.clock);
        field.appendChild(trigger);
        const labelEl = trigger.querySelector('.ui-trigger__label');
        const caption = labelFor(inp);

        function current() {
            const p = /^(\d{2}):(\d{2})$/.exec(inp.value || '');
            if (!p) return { h12: null, period: null, m: null };
            const h24 = Number(p[1]);
            const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
            return { h12: pad(h12), period: h24 < 12 ? 'AM' : 'PM', m: p[2] };
        }

        function to24(h12, period, m) {
            let h = Number(h12) % 12;
            if (period === 'PM') h += 12;
            return `${pad(h)}:${m}`;
        }

        function refresh() {
            const has = !!inp.value;
            labelEl.textContent = has ? formatTime12(inp.value) : 'Elige la hora';
            trigger.classList.toggle('is-placeholder', !has);
            trigger.setAttribute('aria-label', `${caption ? caption + ': ' : ''}${has ? formatTime12(inp.value) : 'sin elegir'}`);
        }

        function paint() {
            const { h12, period, m } = current();
            timeDialog.panel.querySelector('.ui-time__preview').textContent = inp.value ? formatTime12(inp.value) : '— : —';
            timeDialog.panel.querySelectorAll('[data-h]').forEach(b => b.classList.toggle('is-selected', b.dataset.h === h12));
            timeDialog.panel.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('is-selected', b.dataset.m === m));
            timeDialog.panel.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('is-selected', b.dataset.period === period));
        }

        function render() {
            timeDialog.panel.innerHTML = `
                <div class="ui-time__head">
                    <span class="ui-time__preview">— : —</span>
                    <button type="button" class="ui-popover__close" data-close aria-label="Cerrar">&times;</button>
                </div>
                <div class="ui-time__body">
                    <div class="ui-time__cols">
                        <div class="ui-time__col-wrap"><span class="ui-time__cap">Hora</span><div class="ui-time__col" data-col="h">${HOURS12.map(x => `<button type="button" class="ui-time__opt" data-h="${x}">${x}</button>`).join('')}</div></div>
                        <div class="ui-time__col-wrap"><span class="ui-time__cap">Min</span><div class="ui-time__col" data-col="m">${MINUTES5.map(x => `<button type="button" class="ui-time__opt" data-m="${x}">${x}</button>`).join('')}</div></div>
                        <div class="ui-time__col-wrap"><span class="ui-time__cap">&nbsp;</span><div class="ui-time__ampm"><button type="button" class="ui-time__opt" data-period="AM">a. m.</button><button type="button" class="ui-time__opt" data-period="PM">p. m.</button></div></div>
                    </div>
                    <div class="ui-cal__foot"><button type="button" class="ui-link ui-link--strong" data-done>Listo</button></div>
                </div>`;
            paint();
        }

        function centerSelected() {
            timeDialog.panel.querySelectorAll('.ui-time__col').forEach(col => {
                const s = col.querySelector('.is-selected');
                col.scrollTop = s ? s.offsetTop - col.clientHeight / 2 + s.offsetHeight / 2 : 0;
            });
        }

        function handleClick(e) {
            if (e.target.closest('[data-close], [data-done]')) { timeDialog.close(true); return; }
            const hb = e.target.closest('[data-h]');
            const mb = e.target.closest('[data-m]');
            const pb = e.target.closest('[data-period]');
            if (!hb && !mb && !pb) return;
            const cur = current();
            const h12 = hb ? hb.dataset.h : (cur.h12 || '08');
            const m = mb ? mb.dataset.m : (cur.m || '00');
            const period = pb ? pb.dataset.period : (cur.period || 'AM');
            commit(inp, to24(h12, period, m));
            refresh();
            paint();
        }

        trigger.addEventListener('click', () => {
            if (timeDialog.isOpenFor(field)) { timeDialog.close(true); return; }
            timeDialog.open(field, trigger, render, handleClick);
            centerSelected(); // necesita el panel ya visible/medible
        });

        watchValue(inp, refresh, HTMLInputElement.prototype);
        inp.addEventListener('change', refresh);
        inp.addEventListener('input', refresh);
        refresh();
    }

    const SELECTOR = 'select:not([data-ui]), input[type="date"]:not([data-ui]), input[type="time"]:not([data-ui])';

    function enhance(node) {
        if (node.dataset.ui) return;
        if (node.tagName === 'SELECT') enhanceSelect(node);
        else if (node.type === 'date') enhanceDate(node);
        else if (node.type === 'time') enhanceTime(node);
    }

    function enhanceWithin(root) {
        if (root.nodeType !== 1) return;
        if (root.matches(SELECTOR)) enhance(root);
        root.querySelectorAll(SELECTOR).forEach(enhance);
    }

    function start() {
        enhanceWithin(document.body);
        new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(enhanceWithin))).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

    window.UIPickers = { closeOpen: closeOpenPanel, hasOpenPanel: () => !!openPanel };
})();
