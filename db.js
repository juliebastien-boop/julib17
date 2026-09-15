const { Pool } = require('pg');

// Aiven Apps injecte l'URL de connexion Postgres (DATABASE_URL) et le certificat
// CA du projet en base64 (PROJECT_CA_CERT). pg v8 ignore l'option `ssl` si
// `sslmode` est présent dans l'URL, donc on le retire et on fournit le CA
// nous-mêmes pour une vérification TLS correcte.

function buildSsl() {
  if (process.env.PROJECT_CA_CERT) {
    return {
      ca: Buffer.from(process.env.PROJECT_CA_CERT, 'base64').toString('utf-8'),
      rejectUnauthorized: true,
    };
  }
  // Filet de sécurité pour un usage local sans certificat fourni.
  return { rejectUnauthorized: false };
}

function buildConnectionString() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL manquant — le service doit être intégré au service PostgreSQL sur Aiven."
    );
  }
  const url = new URL(raw);
  url.searchParams.delete('sslmode');
  return url.toString();
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  ssl: buildSsl(),
  max: 5,
  idleTimeoutMillis: 30000,
});

module.exports = pool;
