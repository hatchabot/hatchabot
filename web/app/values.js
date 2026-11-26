// web/app/values.js: setup fields (template parameters): the author's side, and a copy's values.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- setup fields (template parameters) — author side ----------------------
// The fields a shared copy's importer is asked to fill in. Edited as a local
// array; Save PATCHes the whole list ({parameters: null} clears it).

let editParams = [];
/** The setup fields as filled or last saved: a list that differs holds an unsaved edit. */
let editParamsSaved = '[]';
/** Fills of the setup fields, counted (prepareEdit): a save's list is the saved one only while no fill came after the press, as v2SheetSaving. */
let editParamsFills = 0;

function renderParamList() {
  $('paramList').innerHTML = editParams.length
    ? editParams.map((p, i) => `<div class="pair"><span class="grow">${esc(p.label || p.key)} <code>{{${esc(p.key)}}}</code>
        <span class="sub">${esc(p.type)}${(p.type === 'choice' || p.type === 'multichoice') && p.options?.length ? ' (' + esc(p.options.join(', ')) + ')' : ''}
          · ${p.target === 'env' ? `env: ${esc(p.key.toUpperCase())}` : p.target === 'datasource' ? 'data repo' : p.target === 'agents' ? 'AGENTS.md' : 'SOUL.md'}${p.required ? ' · <b>required</b>' : ''}${p.default != null && p.default !== '' ? ' · default: ' + esc(String(p.default)) : ''}</span></span>
        <button class="danger" ${onAction('click', 'removeSetupField', [(i)])}>×</button></div>`).join('')
    : '<div class="sub">None declared — sharing still asks for any <code>{{placeholder}}</code> it finds in the files.</div>';
}

function onParamTypeChange() {
  const t = $('paramType').value;
  $('paramOptions').style.display = t === 'choice' || t === 'multichoice' ? '' : 'none';
}

function addSetupField() {
  const key = $('paramKey').value.trim();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) { toast('Key must start with a-z, then a-z 0-9 _ only (max 32 chars)'); return; }
  if (editParams.some(p => p.key === key)) { toast(`{{${key}}} is already declared`); return; }
  if (editParams.length >= 24) { toast('Max 24 setup fields'); return; }
  const type = $('paramType').value;
  const target = $('paramTarget').value;
  if (target === 'env' && type !== 'text') { toast('Env-var fields must be type "text" — the value is a credential, not a choice.'); return; }
  if (target === 'datasource' && type !== 'text') { toast('Data-repo fields must be type "text" — the value is a pasted git URL.'); return; }
  if (target === 'datasource' && $('paramDefault').value.trim()) { toast('Data-repo fields take no default — a default URL would bind every copy to the same repo.'); return; }
  const f = {
    key,
    label: $('paramLabel').value.trim() || key,
    required: $('paramRequired').checked,
    type,
    target,
  };
  const def = $('paramDefault').value.trim();
  if (def) f.default = def;
  if (type === 'choice' || type === 'multichoice') {
    const options = $('paramOptions').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!options.length) { toast('Choice fields need options (comma-separated)'); return; }
    f.options = options;
  }
  editParams.push(f);
  // The field is in the list now, which holds it until Save fields (editParamsSaved): what
  // is left in the boxes above it (a type, a target) is no edit of its own.
  sheetFill(['setupFieldsRow'], () => {
    $('paramKey').value = ''; $('paramLabel').value = ''; $('paramDefault').value = '';
    $('paramOptions').value = ''; $('paramRequired').checked = false;
  });
  renderParamList();
}

// A press fires no input or change event: an edit all the same, and the list against
// editParamsSaved says so, so the sheet's state redraw holds off (HB-0444).
function removeSetupField(i) { editParams.splice(i, 1); renderParamList(); }

async function saveSetupFields() {
  $('editErr').textContent = '';
  const f = sheetSave().hold('paramSaveBtn'), sent = JSON.stringify(editParams), n = editParams.length, fills = editParamsFills;
  try {
    await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { parameters: n ? editParams : null } });
    // Filled again meanwhile (the sheet closed and opened, or another agent and back): the list
    // shown is that fill's, and it is the baseline; the one sent noted under it held the sheet for good.
    f.draw(() => { if (editParamsFills === fills) editParamsSaved = sent; });
    f.say(n ? `Saved ${n} setup field${n > 1 ? 's' : ''} — shared copies now ask for them` : 'Setup fields cleared');
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { f.done(); }
}

// --- Setup VALUES (a configured template copy's current answers) -------------
// Rendered only for agents imported from a template with setup fields: they
// keep the raw placeholder layer, so values stay editable/resettable forever.

function renderSetupValues(a) {
  const row = $('setupValuesRow');
  sheetFill([row], () => {
    // Any RUNNING agent with declared fields is editable: imported copies carry
    // their raw layer already, and on a master the server seeds the layer from
    // the live files on the first Apply (so authors never need Send→Import).
    const fileParams = (a?.parameters ?? []).filter(p => p.target !== 'env' && p.target !== 'datasource');
    const envParams = (a?.parameters ?? []).filter(p => p.target === 'env');
    const dsParams = (a?.parameters ?? []).filter(p => p.target === 'datasource');
    const editable = !!(fileParams.length && a?.state === 'RUNNING');
    row.hidden = !editable;
    if (!editable) return;
    const envNote = envParams.length
      ? `<div class="sub">🔑 ${envParams.map(p => esc(p.key.toUpperCase())).join(', ')} — credential${envParams.length > 1 ? 's' : ''}; change under Advanced → Environment.</div>`
      : '';
    const dsNote = dsParams.length
      ? `<div class="sub">📚 ${dsParams.map(p => esc(p.label || p.key)).join(', ')} — repo binding${dsParams.length > 1 ? 's' : ''}; manage under the Data tab.</div>`
      : '';
    $('setupValuesList').innerHTML = envNote + dsNote + fileParams.map(p => {
      const cur = (a.paramValues ?? {})[p.key] ?? p.default ?? '';
      const help = p.help ? `<div class="sub">${esc(p.help)}</div>` : '';
      let input;
      if (p.type === 'choice') {
        // An optional choice can be cleared: a blank first option (HB-0363).
        const pick = choiceStart(p.options ?? [], cur);
        input = `<select id="spv-${esc(p.key)}" style="width:auto">${p.required ? '' : `<option value=""${pick === '' ? ' selected' : ''}>(none)</option>`}${(p.options ?? [])
          .map(o => `<option value="${esc(o)}"${o === pick ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else if (p.type === 'multichoice') {
        const picked = String(cur).split(',').map(s => s.trim());
        input = `<div id="spv-${esc(p.key)}" style="display:flex;flex-wrap:wrap;gap:10px">${(p.options ?? [])
          .map(o => `<label style="display:flex;gap:5px;align-items:center;font-weight:400;margin:0;width:auto;cursor:pointer">
            <input type="checkbox" data-opt="${esc(o)}"${picked.includes(o) ? ' checked' : ''} style="width:auto;flex:none"> ${esc(o)}</label>`).join('')}</div>`;
      } else if (p.type === 'boolean') {
        input = `<label style="display:flex;gap:6px;align-items:center;width:auto;font-weight:400;margin:0;cursor:pointer">
          <input type="checkbox" id="spv-${esc(p.key)}" style="width:auto;flex:none"${paramYes(cur) ? ' checked' : ''}> enabled</label>`;
      } else if (p.type === 'longtext') {
        input = `<textarea id="spv-${esc(p.key)}" rows="2" style="flex:1;font-size:13px">${esc(cur)}</textarea>`;
      } else {
        input = `<input type="text" id="spv-${esc(p.key)}" value="${esc(cur)}" style="flex:1;min-width:120px">`;
      }
      return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="min-width:180px">${esc(p.label)}${p.required ? ' *' : ''}</span>${input}
      </div>${help}`;
    }).join('');
  });
}

function collectSetupValues(a) {
  // Cleared fields are sent as '' — omitting a key makes the server fall back
  // to the declared default, silently resurrecting the value the owner just
  // deleted (audit 2026-09-03). Explicit empty means empty.
  const values = {};
  for (const p of a.parameters) {
    const el = $(`spv-${p.key}`);
    if (!el) continue;
    if (p.type === 'multichoice') {
      const picks = [...el.querySelectorAll('input:checked')].map(c => c.dataset.opt);
      values[p.key] = picks.join(', ');
      continue;
    }
    values[p.key] = p.type === 'boolean' ? (el.checked ? 'true' : 'false') : el.value.trim();
  }
  return values;
}

async function saveSetupValues() {
  const f = sheetSave();
  const a = agents.find(x => x.id === f.id);
  if (!a) return;
  try {
    const r = await api(`/v1/agents/${f.id}/params`, { method: 'PUT', body: { values: collectSetupValues(a) } });
    // Said, not hidden: a description changed meanwhile that these values could not fill in (HB-0567).
    f.say(r?.warning ? `Values applied, but ⚠ ${r.warning}` : 'Values applied — SOUL/AGENTS re-rendered (snapshot taken first).', r?.warning ? 12000 : undefined);
    await refresh(false);
    // Drawn again only in its own forms: another agent's values being typed stay (HB-0475).
    f.draw(() => renderSetupValues(agents.find(x => x.id === f.id)));
  } catch (e) { f.fail(e); }
}

async function resetSetupValues() {
  const f = sheetSave();
  const a = agents.find(x => x.id === f.id);
  if (!a) return;
  if (!confirm('Reset every setup value to its declared default and re-render the files?\n\nA snapshot is taken first.')) return;
  try {
    const r = await api(`/v1/agents/${f.id}/params`, { method: 'PUT', body: { reset: true } });
    f.say(r?.warning ? `Reset to defaults, but ⚠ ${r.warning}` : 'Reset to defaults.', r?.warning ? 12000 : undefined);
    await refresh(false);
    f.draw(() => renderSetupValues(agents.find(x => x.id === f.id)));
  } catch (e) { f.fail(e); }
}
