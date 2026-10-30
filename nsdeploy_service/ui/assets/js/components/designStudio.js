/**
 * The design editor behind the palette icon: controls on the left, a live
 * preview of the deployed site on the right, applied without a rebuild.
 *
 * WHY THIS IS NOT ONE PROMPT BOX. Two different costs hide behind "change how
 * this site looks", and collapsing them made the cheap one expensive:
 *
 *   · A COLOUR, a radius, a brand word. Every one of these is a named field on
 *     nsdeploy's ThemeSpec that compiles to a CSS custom property. The service
 *     rewrites the built stylesheet and the site serves it on the next page
 *     load (see nsdeploy_service/themespec.py) — no model, no key, no relaunch,
 *     nothing to poll. Previewing it is exact, because the preview sets the same
 *     properties the site does.
 *   · A LAYOUT. Structure is what the design model is actually for, and it
 *     genuinely costs a stop, a rebuild and a few minutes. It stays a prompt,
 *     under its own heading, with its own cost stated.
 *
 * Mixing them meant paying the second price for the first job. Separating them
 * is the whole point of this screen; the editor is just what the separation
 * looks like.
 *
 * The preview is a generic shell (see sitePreview.js). For a network carrying a
 * model-authored layout it shows the right tokens on the wrong structure, so
 * that case says so rather than quietly misleading.
 */
import { api, ApiError } from '../api/client.js';
import { toast } from './toast.js';
import { $, esc, icon, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { openModal } from './modal.js';
import { contrast, isColor, rate, toHex } from '../util/color.js';
import { deploymentsChanged } from '../util/deployments.js';
import { frameHtml, update as updatePreview } from './sitePreview.js';

/**
 * The editable colours, in the order they are worth thinking about: the two
 * that carry brand, then the page, then the parts an operator reaches for last.
 * `pair` is what each is read against for the contrast check — only the
 * combinations the deployed UI actually puts together.
 */
const COLORS = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, the user bubble, active agents' },
  { key: 'accent', label: 'Accent', hint: 'The second half of the user-bubble gradient' },
  { key: 'bg', label: 'Page', hint: 'Behind everything' },
  { key: 'panelbg', label: 'Panel', hint: 'The chat card and side rail' },
  { key: 'fg', label: 'Text', hint: 'Body copy', pair: 'panelbg' },
  { key: 'muted', label: 'Muted text', hint: 'Taglines, labels, placeholders', pair: 'panelbg' },
  { key: 'msgbg', label: 'Agent bubble', hint: 'The assistant’s messages' },
  { key: 'border', label: 'Borders', hint: 'Hairlines between surfaces' },
  { key: 'bg_tint', label: 'Page tint', hint: 'Upper corner of the page gradient' },
];

// Faces that are safe to offer: each is either a system stack or a family that
// is near-universally installed, so a site keeps its chosen face without the
// deployed page having to fetch a webfont it was never given.
const FONTS = [
  { label: 'System', value: '"Segoe UI", system-ui, sans-serif' },
  { label: 'Grotesk', value: 'Inter, "Helvetica Neue", Arial, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Slab', value: '"Rockwell", "Courier Bold", Georgia, serif' },
  { label: 'Mono', value: '"SF Mono", Consolas, "Liberation Mono", monospace' },
];

const TEXT_FIELDS = [
  { key: 'brand', label: 'Brand', max: 60, placeholder: 'Harbor Wheels' },
  { key: 'icon', label: 'Icon', max: 8, placeholder: '\u{1F6B4}', size: 'narrow' },
  { key: 'tagline', label: 'Tagline', max: 120, placeholder: 'Community bike repair' },
];

export async function editDesign(id, rawName, { onUpdated } = {}) {
  const name = displayName(rawName);
  let spec;
  try {
    spec = await api.getThemeSpec(id);
  } catch (error) {
    toast.error(`Could not load ${name}'s design — ${messageOf(error)}`);
    return;
  }
  // Only the layout path needs a key — the token path never calls a model. So
  // this gates that one button rather than the dialog: a missing key must not
  // stop someone recolouring their site. Checked up front because the design
  // pass runs in the deploy child, where a missing key fails the build minutes
  // later and only in its log. A settings call that itself fails is not worth
  // blocking on; let the rebuild report whatever actually goes wrong.
  const keyMissing = await api.getSettings()
    .then((settings) => settings.openai_api_key?.is_set === false)
    .catch(() => false);

  // The draft every control writes into and the preview reads from. Seeded from
  // the server's `current` so an edit starts from what is actually deployed.
  const draft = {
    ...spec.current,
    colors: { ...spec.defaults.colors, ...(spec.current.colors || {}) },
  };
  let dirty = false;
  // Which colour tokens this session has edited. Only these can raise a
  // contrast warning — see showContrast.
  const touched = new Set();

  openModal({
    title: `Design — ${name}`,
    size: 'lg',
    render(body, close) {
      render(body, template(name, spec, draft, keyMissing));

      const frame = $('#design-frame', body);
      const paint = () => updatePreview(frame, draft);
      // srcdoc parses asynchronously, so the first paint waits for the load
      // event; every later one is a direct write into a document already there.
      frame.addEventListener('load', paint);
      if (frame.contentDocument?.readyState === 'complete') paint();

      const touch = () => {
        dirty = true;
        $('#design-apply', body).disabled = false;
        paint();
        showContrast(body, draft, touched);
      };
      showContrast(body, draft, touched);

      // --- colour controls: a swatch and a text field per token -------------
      COLORS.forEach(({ key }) => {
        const swatch = $(`#color-${key}`, body);
        const text = $(`#colortext-${key}`, body);
        swatch.addEventListener('input', () => {
          draft.colors[key] = swatch.value;
          text.value = swatch.value;
          text.setAttribute('aria-invalid', 'false');
          touched.add(key);
          touch();
        });
        // The text field is the escape hatch from a hex-only colour input:
        // rgb(), hsl() and CSS keywords are all valid to the theme layer, and
        // round-tripping them through the swatch would flatten them to hex.
        text.addEventListener('input', () => {
          const value = text.value.trim();
          const valid = isColor(value);
          text.setAttribute('aria-invalid', valid ? 'false' : 'true');
          if (!valid) return;
          draft.colors[key] = value;
          const hex = toHex(value);
          if (hex) swatch.value = hex;
          touched.add(key);
          touch();
        });
      });

      // --- copy, face, radius ----------------------------------------------
      TEXT_FIELDS.forEach(({ key }) => {
        const field = $(`#text-${key}`, body);
        field.addEventListener('input', () => {
          draft[key] = field.value;
          touch();
        });
      });

      const font = $('#design-font', body);
      font.addEventListener('change', () => {
        draft.font = font.value;
        touch();
      });

      const radius = $('#design-radius', body);
      radius.addEventListener('input', () => {
        draft.radius = Number(radius.value);
        $('#design-radius-value', body).textContent = `${radius.value}px`;
        touch();
      });

      // --- reset / apply ----------------------------------------------------
      $('#design-reset', body).addEventListener('click', () => {
        Object.assign(draft, {
          ...spec.defaults,
          colors: { ...spec.defaults.colors },
          // Copy is this network's identity, not part of the stock look — a
          // reset of the palette must not also wipe its name.
          brand: draft.brand, icon: draft.icon, tagline: draft.tagline, hero: draft.hero,
        });
        // Back to the shipped palette, so nothing here is the operator's doing
        // any more and its own contrast shortfalls stop being reported as such.
        touched.clear();
        syncControls(body, draft);
        touch();
      });

      $('[data-close]', body).addEventListener('click', close);
      $('#design-apply', body).addEventListener('click', async () => {
        const button = $('#design-apply', body);
        button.disabled = true;
        button.textContent = 'Applying…';
        try {
          const result = await api.applyThemeSpec(id, tokensOf(draft));
          Object.assign(draft, result.current,
            { colors: { ...draft.colors, ...result.current.colors } });
          syncControls(body, draft);
          paint();
          dirty = false;
          toast.ok(result.applied_live
            ? `${name} restyled — reload its page to see it.`
            : `${name}'s design is saved and will apply on its first build.`);
          onUpdated?.();
        } catch (error) {
          toast.error(`Could not restyle ${name} — ${messageOf(error)}`);
        } finally {
          button.textContent = 'Apply';
          button.disabled = !dirty;
        }
      });

      // --- the layout prompt: the one part that still costs a rebuild -------
      $('#design-layout-apply', body).addEventListener('click', async () => {
        const button = $('#design-layout-apply', body);
        const prompt = $('#design-layout', body).value.trim();
        const error = $('#design-layout-error', body);
        if (!prompt) {
          error.textContent = 'Describe the layout you want.';
          error.hidden = false;
          return;
        }
        error.hidden = true;
        button.disabled = true;
        button.textContent = 'Rebuilding…';
        try {
          // theme + theme_refresh are implied: without the refresh nsdeploy
          // reuses the editable source already on disk and the new words would
          // be silently ignored (see nsdeploy/__main__.py's theme resolution).
          await api.updateTheme(id, { theme: true, theme_refresh: true, theme_prompt: prompt });
          toast.ok(`${name} is rebuilding with a new layout.`);
          // A rebuild relaunches the network, so its pin goes back to pending and
          // then ready. Without this the map would show a stale status ring until
          // its own slow poll came round.
          deploymentsChanged();
          close();
          onUpdated?.();
        } catch (err) {
          toast.error(`Could not rebuild ${name} — ${messageOf(err)}`);
          button.disabled = false;
          button.textContent = 'Rebuild with this layout';
        }
      });
    },
  });
}

function template(name, spec, draft, keyMissing) {
  const notice = noticeFor(spec);
  return `
  <div class="design">
    <div class="design__controls">
      ${notice ? `<p class="design__notice">${notice}</p>` : ''}

      <div class="design__group">
        <h3 class="design__grouphead">Identity</h3>
        <div class="design__fields">
          ${TEXT_FIELDS.map((field) => `
            <label class="design__field ${field.size === 'narrow' ? 'design__field--narrow' : ''}">
              <span class="design__label">${esc(field.label)}</span>
              <input class="input input--sm" id="text-${field.key}" type="text"
                     maxlength="${field.max}" placeholder="${esc(field.placeholder)}"
                     value="${esc(draft[field.key] || '')}">
            </label>`).join('')}
        </div>
      </div>

      <div class="design__group">
        <h3 class="design__grouphead">Colour</h3>
        <div class="design__swatches">
          ${COLORS.map(({ key, label, hint }) => `
            <div class="design__swatch" title="${esc(hint)}">
              <input type="color" id="color-${key}" aria-label="${esc(label)}"
                     value="${esc(toHex(draft.colors[key]) || '#000000')}">
              <div class="design__swatchmeta">
                <label class="design__label" for="colortext-${key}">${esc(label)}</label>
                <input class="input input--sm design__hex" id="colortext-${key}" type="text"
                       value="${esc(draft.colors[key] || '')}" spellcheck="false"
                       autocomplete="off" maxlength="40" aria-describedby="hint-${key}">
                <span class="design__hint" id="hint-${key}">${esc(hint)}</span>
              </div>
            </div>`).join('')}
        </div>
        <p class="design__contrast" id="design-contrast"></p>
      </div>

      <div class="design__group">
        <h3 class="design__grouphead">Shape</h3>
        <div class="design__fields">
          <label class="design__field">
            <span class="design__label">Typeface</span>
            <select class="input input--sm" id="design-font">
              ${FONTS.map((f) => `
                <option value="${esc(f.value)}" ${sameFont(f.value, draft.font) ? 'selected' : ''}>
                  ${esc(f.label)}
                </option>`).join('')}
              ${FONTS.some((f) => sameFont(f.value, draft.font)) ? '' : `
                <option value="${esc(draft.font || '')}" selected>
                  Current (${esc(firstFace(draft.font))})
                </option>`}
            </select>
          </label>
          <label class="design__field">
            <span class="design__label">
              Corner radius <span class="design__value" id="design-radius-value">${draft.radius}px</span>
            </span>
            <input type="range" id="design-radius" min="0" max="28" step="1"
                   value="${draft.radius}">
          </label>
        </div>
      </div>

    </div>

    <div class="design__preview">
      <div class="design__previewhead">
        ${icon('eye', { size: 13 })}
        <span>Preview</span>
        <small>${spec.has_custom_layout ? 'standard surfaces' : 'as deployed'}</small>
      </div>
      ${frameHtml({ label: `Preview of ${name}` })}

      <!-- Layout sits under the preview, not under the colour controls: the
           controls column is already as tall as the dialog, and a group that
           only exists below a scroll is a group nobody finds — least of all
           when what it has to say is "this one is disabled, and why". -->
      <div class="design__group design__group--layout">
        <h3 class="design__grouphead">Layout</h3>
        <p class="design__hint">
          The model's job, and the only change here that needs a rebuild — ${esc(name)}
          stops, rebuilds and relaunches, a few minutes.
          <strong>It replaces the palette and copy above</strong> with the model's own:
          it designs the whole look, not only the structure.
        </p>
        <textarea class="input input--sm" id="design-layout" rows="2" maxlength="4000"
                  placeholder="e.g. A full-bleed hero above the chat, agents in a left rail"
                  spellcheck="false" ${keyMissing ? 'disabled' : ''}></textarea>
        <p class="field__error" id="design-layout-error" ${keyMissing ? '' : 'hidden'}>${
          keyMissing
            ? 'No OpenAI API key — only a layout needs one.'
            : ''
        }</p>
        <button type="button" class="btn btn--secondary btn--sm" id="design-layout-apply"
                ${keyMissing ? 'disabled' : ''}>
          Rebuild with this layout
        </button>
      </div>
    </div>
  </div>
  <div class="modal__foot">
    <button type="button" class="btn btn--ghost" id="design-reset"
            style="margin-right:auto">Reset the palette</button>
    <button type="button" class="btn btn--secondary" data-close>Close</button>
    <button type="button" class="btn btn--primary" id="design-apply" disabled>Apply</button>
  </div>`;
}

/** The one thing worth saying before an operator starts dragging sliders. */
function noticeFor(spec) {
  if (!spec.built) {
    return 'This network has no build yet, so there is nothing to restyle live — '
      + 'what you save here is applied by its first build.';
  }
  if (spec.has_custom_layout) {
    return 'This network has a design-model layout. Your colours and copy are exact, '
      + 'but the preview shows the standard surfaces rather than that layout — '
      + 'which editing these tokens leaves untouched.';
  }
  return '';
}

/** Push the draft back into the controls — after a reset, or after an apply
 * normalizes a value (a font stack gains a generic family, text is trimmed). */
function syncControls(root, draft) {
  COLORS.forEach(({ key }) => {
    const value = draft.colors[key] || '';
    $(`#colortext-${key}`, root).value = value;
    $(`#colortext-${key}`, root).setAttribute('aria-invalid', 'false');
    const hex = toHex(value);
    if (hex) $(`#color-${key}`, root).value = hex;
  });
  TEXT_FIELDS.forEach(({ key }) => { $(`#text-${key}`, root).value = draft[key] || ''; });
  $('#design-radius', root).value = draft.radius;
  $('#design-radius-value', root).textContent = `${draft.radius}px`;
  const font = $('#design-font', root);
  const match = [...font.options].find((option) => sameFont(option.value, draft.font));
  if (match) font.value = match.value;
}

/**
 * Report the text pairs WCAG AA governs, while they are being chosen.
 *
 * Only the pairs the deployed UI actually puts together. The user bubble is
 * white on a gradient between two editable colours, so it is measured against
 * the LIGHTER end — the worst case for white text is the one that decides
 * whether the bubble is readable.
 *
 * WARNS ONLY FOR WHAT THE OPERATOR TOUCHED. The shipped palette is already
 * below AA in two of these three pairs (muted text 4.35:1, white on the default
 * primary 2.77:1), so warning on everything would mean opening this editor to
 * three complaints about choices nobody here made — and a warning that is
 * always on is a warning nobody reads. The numbers are always shown, so a
 * pre-existing problem is visible; the alarm is reserved for a pair whose own
 * colours this session changed.
 */
function showContrast(root, draft, touched = new Set()) {
  const c = draft.colors;
  const checks = [
    { label: 'Text on panel', keys: ['fg', 'panelbg'], ratio: contrast(c.fg, c.panelbg) },
    { label: 'Muted text', keys: ['muted', 'panelbg'], ratio: contrast(c.muted, c.panelbg) },
    {
      label: 'Bubble text',
      keys: ['primary', 'accent'],
      ratio: contrast('#ffffff', lighter(c.primary, c.accent)),
    },
  ].map((check) => ({ ...check, verdict: rate(check.ratio) }));

  const mine = checks.filter(
    (check) => !check.verdict.ok && check.keys.some((key) => touched.has(key)),
  );
  const node = $('#design-contrast', root);
  node.className = `design__contrast ${mine.length ? 'design__contrast--warn' : ''}`;
  node.textContent = mine.length
    ? `${mine.map((check) => `${check.label} ${ratioOf(check)}`).join(' · ')}`
      + ' — below the AA floor of 4.5:1 for small text.'
    : checks.map((check) => `${check.label} ${ratioOf(check)}`).join(' · ');
}

/** The ratio alone, for the neutral line — the AA/AAA grade is the warning's
 * job, and repeating it in the quiet state reads as a verdict on colours the
 * operator may not have chosen. */
function ratioOf(check) {
  return check.ratio === null ? '—' : `${check.ratio.toFixed(1)}:1`;
}

/** Whichever of two colours is lighter — the worse backdrop for white text. */
function lighter(a, b) {
  const onWhite = (value) => contrast(value, '#ffffff') ?? Infinity;
  return onWhite(a) <= onWhite(b) ? a : b;
}

/** The tokens the API takes — the draft minus anything it does not own. */
function tokensOf(draft) {
  return {
    brand: draft.brand || '', icon: draft.icon || '', tagline: draft.tagline || '',
    font: draft.font, radius: draft.radius, colors: { ...draft.colors },
  };
}

/** Font stacks compare loosely: the server normalizes one by appending a generic
 * family, so an exact match would stop recognizing the option the operator just
 * picked. */
function sameFont(a, b) {
  return faceOf(a) === faceOf(b);
}

function faceOf(stack) {
  return firstFace(stack).toLowerCase();
}

/** The first family in a stack, as written — for showing a face back to the
 * operator, where case is theirs and not ours to flatten. */
function firstFace(stack) {
  return String(stack || '').split(',')[0].replace(/["']/g, '').trim();
}

function messageOf(error) {
  return error instanceof ApiError ? error.message : String(error);
}
