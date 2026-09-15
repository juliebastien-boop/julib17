const state = {
  q: '',
  categorie: '',
  region: '',
  statut: '',
  couleur: '',
  score_min: 80,
  sort: 'score_desc',
  tagIds: new Set(),
  page: 1,
};

let ALL_TAGS = [];

const $ = (sel) => document.querySelector(sel);
const resultsEl = $('#results');
const paginationEl = $('#pagination');
const statsEl = $('#stats');

function money(v) {
  if (v === null || v === undefined) return '';
  return `${Number(v).toFixed(0)} €`;
}

function couleurLabel(c) {
  return { rouge: 'rouge', blanc: 'blanc', rose: 'rosé', effervescent: 'effervescent' }[c] || '';
}

function categorieLabel(c) {
  return { pepite: 'pépite', valeur_sure: 'valeur sûre' }[c] || '';
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  const [regions, tags, stats] = await Promise.all([
    fetchJSON('/api/regions'),
    fetchJSON('/api/tags'),
    fetchJSON('/api/stats'),
  ]);

  ALL_TAGS = tags;

  const regionSelect = $('#f-region');
  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    regionSelect.appendChild(opt);
  }

  const tagsGrid = $('#f-tags');
  for (const t of tags) {
    const btn = document.createElement('button');
    btn.className = 'tag-toggle';
    btn.textContent = t.nom;
    btn.dataset.tagId = t.id;
    btn.addEventListener('click', () => {
      if (state.tagIds.has(t.id)) {
        state.tagIds.delete(t.id);
        btn.classList.remove('active');
      } else {
        state.tagIds.add(t.id);
        btn.classList.add('active');
      }
      state.page = 1;
      loadResults();
    });
    tagsGrid.appendChild(btn);
  }

  renderStats(stats);
  bindControls();
  loadResults();
}

function renderStats(stats) {
  statsEl.textContent = `${stats.total} vins · ${stats.pepites} pépites · ${stats.valeurs_sures} valeurs sûres · ${stats.degustes} dégustés`;
}

function bindControls() {
  let debounceTimer;
  $('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    state.page = 1;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadResults, 350);
  });

  document.querySelectorAll('#view-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#view-chips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.categorie = chip.dataset.categorie;
      state.page = 1;
      loadResults();
    });
  });

  $('#f-region').addEventListener('change', (e) => { state.region = e.target.value; state.page = 1; loadResults(); });
  $('#f-statut').addEventListener('change', (e) => { state.statut = e.target.value; state.page = 1; loadResults(); });
  $('#f-couleur').addEventListener('change', (e) => { state.couleur = e.target.value; state.page = 1; loadResults(); });
  $('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; loadResults(); });

  const scoreInput = $('#f-score');
  const scoreVal = $('#f-score-val');
  scoreInput.addEventListener('input', (e) => {
    scoreVal.textContent = e.target.value;
    state.score_min = Number(e.target.value);
    state.page = 1;
    loadResults();
  });

  $('#overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeDetail();
  });
}

// ---------------------------------------------------------------------------
// Liste des résultats
// ---------------------------------------------------------------------------

function buildQueryParams() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.categorie) params.set('categorie', state.categorie);
  if (state.region) params.set('region', state.region);
  if (state.statut) params.set('statut', state.statut);
  if (state.couleur) params.set('couleur', state.couleur);
  if (state.score_min > 80) params.set('score_min', state.score_min);
  if (state.sort) params.set('sort', state.sort);
  if (state.tagIds.size) params.set('tag', [...state.tagIds].join(','));
  params.set('page', state.page);
  params.set('page_size', 30);
  return params;
}

async function loadResults() {
  const params = buildQueryParams();
  resultsEl.innerHTML = '<p class="empty-state">Recherche en cours…</p>';
  try {
    const data = await fetchJSON(`/api/wines?${params.toString()}`);
    renderResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<p class="empty-state">Erreur : ${err.message}</p>`;
  }
}

function renderResults(data) {
  if (!data.results.length) {
    resultsEl.innerHTML = '<p class="empty-state">Aucun vin ne correspond à cette recherche.</p>';
    paginationEl.innerHTML = '';
    return;
  }

  resultsEl.innerHTML = '';
  for (const vin of data.results) {
    resultsEl.appendChild(renderWineRow(vin));
  }

  renderPagination(data);
}

function renderWineRow(vin) {
  const row = document.createElement('article');
  row.className = 'wine-row';
  row.addEventListener('click', () => openDetail(vin.id));

  const sub = [vin.appellation, vin.millesime, couleurLabel(vin.couleur_estimee)].filter(Boolean).join(' · ');

  row.innerHTML = `
    <div class="wine-main">
      <div class="wine-name">${escapeHtml(vin.nom)}</div>
      <div class="wine-sub">${escapeHtml(vin.producteur)}<span class="sep">·</span>${escapeHtml(sub)}</div>
    </div>
    <div class="wine-meta">
      <div class="wine-score">
        ${vin.score_qualite_perso !== null ? `<span class="perso">${vin.score_qualite_perso}</span>` : vin.score_qualite_estime}
      </div>
      ${vin.prix !== null ? `<span class="wine-prix">${money(vin.prix)}</span>` : ''}
      ${vin.categorie ? `<span class="wine-badge ${vin.categorie}">${categorieLabel(vin.categorie)}</span>` : ''}
    </div>
  `;
  return row;
}

function renderPagination(data) {
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  paginationEl.innerHTML = '';
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.textContent = '← précédent';
  prev.disabled = data.page <= 1;
  prev.addEventListener('click', () => { state.page -= 1; loadResults(); });

  const label = document.createElement('span');
  label.textContent = `page ${data.page} / ${totalPages}`;

  const next = document.createElement('button');
  next.textContent = 'suivant →';
  next.disabled = data.page >= totalPages;
  next.addEventListener('click', () => { state.page += 1; loadResults(); });

  paginationEl.append(prev, label, next);
}

// ---------------------------------------------------------------------------
// Panneau détail + formulaire de dégustation
// ---------------------------------------------------------------------------

async function openDetail(id) {
  const overlay = $('#overlay');
  const panel = $('#detail-panel');
  overlay.hidden = false;
  panel.innerHTML = '<p class="empty-state">Chargement…</p>';

  try {
    const vin = await fetchJSON(`/api/wines/${id}`);
    panel.innerHTML = renderDetailHtml(vin);
    bindDetailForm(vin);
    $('#close-detail').addEventListener('click', closeDetail);
  } catch (err) {
    panel.innerHTML = `<p class="empty-state">Erreur : ${err.message}</p>`;
  }
}

function closeDetail() {
  $('#overlay').hidden = true;
}

function renderDetailHtml(vin) {
  const tagsEstimation = vin.tags.filter((t) => t.origine === 'estimation');
  const tagsDegustation = vin.tags.filter((t) => t.origine === 'degustation');

  const tagPill = (t, cls) => `<span class="tag-pill ${cls}">${escapeHtml(t.nom)}</span>`;

  const prixRows = vin.prix_historique.length
    ? vin.prix_historique
        .map(
          (p) => `<div class="price-row"><span>${new Date(p.date_releve).toLocaleDateString('fr-FR')} · ${escapeHtml(p.source_url || '')}</span><span>${money(p.prix)}</span></div>`
        )
        .join('')
    : '<p class="empty-state" style="padding:0.5rem 0;">Aucun relevé de prix.</p>';

  const tagCheckboxes = ALL_TAGS.map((t) => {
    const active = tagsDegustation.some((td) => td.id === t.id);
    return `<button type="button" class="tag-toggle deg-tag-toggle${active ? ' active' : ''}" data-tag-id="${t.id}">${escapeHtml(t.nom)}</button>`;
  }).join('');

  return `
    <button class="close-btn" id="close-detail">&times;</button>
    <h2 class="detail-title">${escapeHtml(vin.nom)}</h2>
    <p class="detail-sub">${escapeHtml(vin.producteur)} (${escapeHtml(vin.statut || '')}) — ${escapeHtml(vin.appellation)}, ${escapeHtml(vin.province || '')}</p>

    <dl class="detail-grid">
      <div><dt>Millésime</dt><dd>${vin.millesime ?? '—'}</dd></div>
      <div><dt>Cépage</dt><dd>${escapeHtml(vin.cepage || '—')}</dd></div>
      <div><dt>Couleur (estimée)</dt><dd>${couleurLabel(vin.couleur_estimee) || '—'}</dd></div>
      <div><dt>Score estimé</dt><dd>${vin.score_qualite_estime ?? '—'}</dd></div>
      <div><dt>Score personnel</dt><dd>${vin.score_qualite_perso ?? '— (pas encore dégusté)'}</dd></div>
      <div><dt>Statut</dt><dd>${vin.categorie ? categorieLabel(vin.categorie) : '—'}</dd></div>
    </dl>

    <div class="detail-section">
      <h3>Caractéristiques</h3>
      <p style="margin:0 0 0.4rem;font-size:0.75rem;color:var(--muted);">estimées (à partir de la fiche d'origine)</p>
      <div>${tagsEstimation.length ? tagsEstimation.map((t) => tagPill(t, 'estimation')).join('') : '<span class="empty-state">aucune</span>'}</div>
      <p style="margin:0.8rem 0 0.4rem;font-size:0.75rem;color:var(--muted);">tes dégustations</p>
      <div>${tagsDegustation.length ? tagsDegustation.map((t) => tagPill(t, 'degustation')).join('') : '<span class="empty-state">tu n\'as pas encore noté ce vin</span>'}</div>
    </div>

    <div class="detail-section">
      <h3>Relevés de prix</h3>
      ${prixRows}
    </div>

    <div class="detail-section degustation-form">
      <h3>Noter une dégustation</h3>
      <label for="deg-score">Ma note (0–100)</label>
      <input type="range" id="deg-score" min="0" max="100" value="${vin.score_qualite_perso ?? vin.score_qualite_estime ?? 85}" />
      <span id="deg-score-val">${vin.score_qualite_perso ?? vin.score_qualite_estime ?? 85}</span>

      <label>Mes sensations</label>
      <div class="tags-grid">${tagCheckboxes}</div>

      <label for="deg-note">Notes personnelles</label>
      <textarea id="deg-note" rows="3" placeholder="ce que tu as pensé de ce vin…">${escapeHtml(vin.notes || '')}</textarea>

      <button class="submit-btn" id="deg-submit">Enregistrer ma dégustation</button>
      <p class="form-status" id="deg-status"></p>
    </div>
  `;
}

function bindDetailForm(vin) {
  const scoreInput = $('#deg-score');
  const scoreVal = $('#deg-score-val');
  scoreInput.addEventListener('input', (e) => { scoreVal.textContent = e.target.value; });

  const selectedTags = new Set(vin.tags.filter((t) => t.origine === 'degustation').map((t) => t.id));

  document.querySelectorAll('.deg-tag-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tagId = Number(btn.dataset.tagId);
      if (selectedTags.has(tagId)) {
        selectedTags.delete(tagId);
        btn.classList.remove('active');
      } else {
        selectedTags.add(tagId);
        btn.classList.add('active');
      }
    });
  });

  $('#deg-submit').addEventListener('click', async () => {
    const statusEl = $('#deg-status');
    statusEl.textContent = 'Enregistrement…';
    try {
      await fetchJSON(`/api/wines/${vin.id}/degustation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          score: Number(scoreInput.value),
          tags: [...selectedTags],
          note: $('#deg-note').value,
        }),
      });
      statusEl.textContent = 'Dégustation enregistrée.';
      loadResults();
      fetchJSON('/api/stats').then(renderStats);
    } catch (err) {
      statusEl.textContent = `Erreur : ${err.message}`;
    }
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init().catch((err) => {
  resultsEl.innerHTML = `<p class="empty-state">Erreur de chargement : ${err.message}</p>`;
});
