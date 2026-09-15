const path = require('path');
const express = require('express');
const pool = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const SEUIL_PEPITE_VALEUR_SURE = 88; // score minimal pour être qualifié "pépite" / "valeur sûre"

// ---------------------------------------------------------------------------
// CASE SQL pour estimer la couleur à partir du cépage (le dataset source ne
// renseigne pas la couleur). C'est une estimation — affichée comme telle
// côté interface, jamais présentée comme une donnée certaine.
// ---------------------------------------------------------------------------
const COULEUR_CASE = `
  CASE
    WHEN v.cepage ILIKE '%champagne%' OR v.cepage ILIKE '%sparkling%' OR v.cepage = 'Pinot Meunier' THEN 'effervescent'
    WHEN v.cepage = 'Rosé' THEN 'rose'
    WHEN v.cepage ILIKE '%red blend%' OR v.cepage IN (
      'Cabernet Franc','Cabernet Franc-Cabernet Sauvignon','Cabernet Sauvignon','Cabernet-Syrah',
      'Carignan','Gamay','Grenache','Grenache-Syrah','Malbec','Malbec-Merlot','Mansois','Merlot',
      'Mondeuse','Negrette','Pinot Noir','Pinot Noir-Gamay','Syrah','Syrah-Cabernet','Syrah-Grenache',
      'Syrah-Viognier','Tannat','Tannat-Cabernet','Trousseau','Braucol','Duras'
    ) THEN 'rouge'
    WHEN v.cepage ILIKE '%white blend%' OR v.cepage IN (
      'Auxerrois','Chardonnay','Chardonnay-Viognier','Chenin Blanc','Chenin Blanc-Chardonnay','Colombard',
      'Gewürztraminer','Gros and Petit Manseng','Gros Manseng','Jacquère','Loin de l''Oeil','Marsanne',
      'Mauzac','Melon','Moscato','Muscadelle','Muscat','Petit Manseng','Pinot Auxerrois','Pinot Blanc',
      'Pinot Blanc-Chardonnay','Pinot Gris','Riesling','Roussanne','Sauvignon','Sauvignon Blanc',
      'Sauvignon Blanc-Chardonnay','Savagnin','Sylvaner','Viognier'
    ) THEN 'blanc'
    ELSE NULL
  END
`;

const BASE_CTE = `
  WITH base AS (
    SELECT
      v.id, v.nom, v.millesime, v.cepage, v.score_qualite_estime, v.score_qualite_perso, v.notes,
      p.id AS producteur_id, p.nom AS producteur, p.statut,
      a.id AS appellation_id, a.nom AS appellation, a.province,
      prix.prix AS prix,
      COALESCE(v.score_qualite_perso, v.score_qualite_estime) AS score_final,
      ${COULEUR_CASE} AS couleur_estimee
    FROM vins v
    JOIN producteurs p ON p.id = v.producteur_id
    JOIN appellations a ON a.id = v.appellation_id
    LEFT JOIN LATERAL (
      SELECT pr.prix FROM prix_releves pr WHERE pr.vin_id = v.id ORDER BY pr.date_releve DESC LIMIT 1
    ) prix ON true
  ),
  enriched AS (
    SELECT *,
      CASE
        WHEN statut IN ('niche', 'petit producteur') AND score_final >= ${SEUIL_PEPITE_VALEUR_SURE} THEN 'pepite'
        WHEN statut = 'connu' AND score_final >= ${SEUIL_PEPITE_VALEUR_SURE} THEN 'valeur_sure'
        ELSE NULL
      END AS categorie
    FROM base
  )
`;

const SORT_MAP = {
  score_desc: 'score_final DESC NULLS LAST, nom ASC',
  score_asc: 'score_final ASC NULLS LAST, nom ASC',
  prix_asc: 'prix ASC NULLS LAST, score_final DESC',
  prix_desc: 'prix DESC NULLS LAST, score_final DESC',
  nom_asc: 'nom ASC',
  millesime_desc: 'millesime DESC NULLS LAST, score_final DESC',
  ratio_desc: '(score_final / NULLIF(prix, 0)) DESC NULLS LAST, score_final DESC',
};

// ---------------------------------------------------------------------------
// Interprétation (très simple, sans LLM) du champ de recherche libre :
// on repère quelques intentions courantes et on matche les mots restants
// sur le nom / producteur / appellation / cépage / tags.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'vin', 'vins', 'un', 'une', 'de', 'du', 'des', 'le', 'la', 'les', 'pour', 'ma', 'mon', 'mes',
  'cave', 'à', 'a', 'avec', 'et', 'ou', 'qui', 'que', 'bon', 'bonne', 'bons', 'bonnes', 'sur',
  'ce', 'cette', 'ces', 'plutot', 'plutôt', 'je', 'veux', 'cherche', 'trouve', 'moi', 'un peu',
]);

const INTENT_WORDS = new Set([
  'qualité', 'qualite', 'prix', 'rapport',
  'garder', 'garde', 'gardera', 'vieillir', 'vieillissement', 'longue', 'garder.',
  'pépite', 'pepite', 'pépites', 'pepites',
  'valeur', 'valeurs', 'sûre', 'sure', 'sûres', 'sures',
  'rouge', 'blanc', 'rosé', 'rose', 'effervescent', 'pétillant', 'petillant', 'champagne',
  'dégusté', 'deguste', 'dégustés', 'degustes', 'noté', 'note', 'notés', 'notes',
]);

const COULEUR_MOTS = {
  rouge: 'rouge',
  blanc: 'blanc',
  rosé: 'rose',
  rose: 'rose',
  effervescent: 'effervescent',
  pétillant: 'effervescent',
  petillant: 'effervescent',
  champagne: 'effervescent',
};

function tokenize(q) {
  return q
    .toLowerCase()
    .split(/[^a-zàâäéèêëïîôöùûüçœ]+/i)
    .filter(Boolean);
}

function interpreterRechercheLibre(q) {
  const tokens = tokenize(q);
  const contenu = [];
  const intent = {};

  const hasQualite = tokens.includes('qualité') || tokens.includes('qualite');
  const hasPrix = tokens.includes('prix');
  if (hasQualite && hasPrix) intent.sort = 'ratio_desc';

  if (tokens.some((t) => ['garder', 'garde', 'gardera', 'vieillir', 'vieillissement'].includes(t))) {
    intent.score_min = 90;
    intent.sort = intent.sort || 'score_desc';
  }

  if (tokens.some((t) => t.startsWith('pépite') || t.startsWith('pepite'))) {
    intent.categorie = 'pepite';
  }
  if (tokens.includes('valeur') || tokens.includes('valeurs')) {
    intent.categorie = 'valeur_sure';
  }
  if (tokens.some((t) => t.startsWith('degust') || t.startsWith('dégust') || t.startsWith('not'))) {
    intent.categorie = intent.categorie || 'degustes';
  }

  for (const t of tokens) {
    if (COULEUR_MOTS[t]) intent.couleur = COULEUR_MOTS[t];
  }

  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t) || INTENT_WORDS.has(t)) continue;
    contenu.push(t);
  }

  return { contenu, intent };
}

// ---------------------------------------------------------------------------
// Construction dynamique de la clause WHERE (paramétrée, sans injection)
// ---------------------------------------------------------------------------
function buildWhere(query) {
  const params = [];
  const clauses = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  let { region, statut, couleur, tag, categorie, millesime_min, millesime_max, score_min, q, sort } = query;

  let contenuTokens = [];
  if (q && q.trim()) {
    const { contenu, intent } = interpreterRechercheLibre(q.trim());
    contenuTokens = contenu;
    couleur = couleur || intent.couleur;
    categorie = categorie || intent.categorie;
    score_min = score_min || intent.score_min;
    sort = sort || intent.sort;
  }

  if (region) clauses.push(`province = ${add(region)}`);
  if (statut) clauses.push(`statut = ${add(statut)}`);
  if (couleur) clauses.push(`couleur_estimee = ${add(couleur)}`);
  if (categorie) clauses.push(`categorie = ${add(categorie)}`);
  if (millesime_min) clauses.push(`millesime >= ${add(Number(millesime_min))}`);
  if (millesime_max) clauses.push(`millesime <= ${add(Number(millesime_max))}`);
  if (score_min) clauses.push(`score_final >= ${add(Number(score_min))}`);

  if (tag) {
    const tagIds = String(tag)
      .split(',')
      .map((t) => Number(t))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (tagIds.length) {
      clauses.push(`id IN (SELECT vin_id FROM vins_tags WHERE tag_id = ANY(${add(tagIds)}))`);
    }
  }

  for (const token of contenuTokens) {
    const p = add(`%${token}%`);
    clauses.push(`(
      nom ILIKE ${p}
      OR producteur ILIKE ${p}
      OR appellation ILIKE ${p}
      OR cepage ILIKE ${p}
      OR id IN (SELECT vt.vin_id FROM vins_tags vt JOIN tags t ON t.id = vt.tag_id WHERE t.nom ILIKE ${p})
    )`);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = SORT_MAP[sort] || SORT_MAP.score_desc;
  return { whereSql, params, orderBy };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/regions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT province FROM appellations WHERE province IS NOT NULL ORDER BY province`
    );
    res.json(rows.map((r) => r.province));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tags', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nom FROM tags ORDER BY nom`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      ${BASE_CTE}
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE score_qualite_perso IS NOT NULL) AS degustes,
        count(*) FILTER (WHERE categorie = 'pepite') AS pepites,
        count(*) FILTER (WHERE categorie = 'valeur_sure') AS valeurs_sures
      FROM enriched
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wines', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 40));
    const { whereSql, params, orderBy } = buildWhere(req.query);

    const countSql = `${BASE_CTE} SELECT COUNT(*) AS total FROM enriched ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = Number(countRows[0].total);

    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const listSql = `
      ${BASE_CTE}
      SELECT * FROM enriched
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const { rows } = await pool.query(listSql, listParams);

    res.json({ total, page, page_size: pageSize, results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wines/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' });

    const { rows } = await pool.query(`${BASE_CTE} SELECT * FROM enriched WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'vin introuvable' });
    const vin = rows[0];

    const { rows: tags } = await pool.query(
      `SELECT t.id, t.nom, vt.origine
       FROM vins_tags vt JOIN tags t ON t.id = vt.tag_id
       WHERE vt.vin_id = $1
       ORDER BY vt.origine, t.nom`,
      [id]
    );

    const { rows: prixHistorique } = await pool.query(
      `SELECT prix, date_releve, source_url, disponible
       FROM prix_releves WHERE vin_id = $1 ORDER BY date_releve DESC`,
      [id]
    );

    res.json({ ...vin, tags, prix_historique: prixHistorique });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wines/:id/degustation', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' });

  const { score, tags, note } = req.body || {};
  if (score !== undefined && score !== null) {
    const s = Number(score);
    if (!Number.isFinite(s) || s < 0 || s > 100) {
      return res.status(400).json({ error: 'score doit être compris entre 0 et 100' });
    }
  }
  const tagIds = Array.isArray(tags) ? tags.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (score !== undefined && score !== null) {
      await client.query(`UPDATE vins SET score_qualite_perso = $1 WHERE id = $2`, [score, id]);
    }
    if (typeof note === 'string' && note.trim()) {
      await client.query(`UPDATE vins SET notes = $1 WHERE id = $2`, [note.trim(), id]);
    }

    await client.query(`DELETE FROM vins_tags WHERE vin_id = $1 AND origine = 'degustation'`, [id]);
    for (const tagId of tagIds) {
      await client.query(
        `INSERT INTO vins_tags (vin_id, tag_id, origine) VALUES ($1, $2, 'degustation')
         ON CONFLICT DO NOTHING`,
        [id, tagId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  try {
    const { rows } = await pool.query(`${BASE_CTE} SELECT * FROM enriched WHERE id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ma cave à vins — serveur démarré sur le port ${PORT}`);
});
