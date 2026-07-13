/*
 * Cek Plagiasi — Turnitin Core API (TCA), mode NO REPOSITORY
 *
 * Alur:
 *   1. POST /api/check    : terima file, buat submission di Turnitin, upload file
 *   2. GET  /api/status/:id : pantau status; saat file selesai diproses, server
 *      otomatis meminta similarity report dengan indexing_settings.add_to_index=false
 *      (dokumen TIDAK disimpan/diindeks ke repositori Turnitin)
 *   3. POST /api/viewer/:id : ambil URL Similarity Viewer Turnitin
 *   4. GET  /api/pdf/:id    : generate + unduh laporan PDF
 *
 * Tanpa TCA_BASE_URL / TCA_API_KEY, server berjalan dalam MODE DEMO (simulasi).
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // batas Turnitin: 100 MB
});

const BASE = (process.env.TCA_BASE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.TCA_API_KEY || '').trim();
const OWNER_ID = (process.env.TCA_OWNER_ID || 'pemilik-utama').trim();
const PORT = process.env.PORT || 3000;
const DEMO_MODE = !BASE || !API_KEY;

const ALLOWED_EXT = ['.pdf', '.docx'];

// Penyimpanan status pekerjaan di memori (cukup untuk satu instance server)
const jobs = new Map();

/* ---------------------------------------------------------------- *
 *  Klien Turnitin Core API
 * ---------------------------------------------------------------- */

function tcaHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'X-Turnitin-Integration-Name': 'CekPlagiasiWeb',
    'X-Turnitin-Integration-Version': '1.0.0',
    ...extra,
  };
}

async function tca(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}/api/v1${pathname}`, {
    method,
    headers: tcaHeaders(body && !raw ? { 'Content-Type': 'application/json', ...headers } : headers),
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Turnitin API ${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (raw === 'buffer') return Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// EULA terbaru di-cache; wajib disetujui pemilik sebelum submission dibuat
let eulaCache = null;
async function getLatestEula() {
  if (!eulaCache) eulaCache = await tca('/eula/latest');
  return eulaCache;
}

async function createSubmission(title) {
  const eula = await getLatestEula();
  return tca('/submissions', {
    method: 'POST',
    body: {
      owner: OWNER_ID,
      title,
      submitter: OWNER_ID,
      owner_default_permission_set: 'INSTRUCTOR',
      eula: {
        version: eula.version,
        language: 'en-US',
        accepted_timestamp: new Date().toISOString(),
      },
      metadata: {
        owners: [{ id: OWNER_ID }],
        original_submitted_time: new Date().toISOString(),
      },
    },
  });
}

async function uploadFile(submissionId, filename, buffer) {
  return tca(`/submissions/${submissionId}/original`, {
    method: 'PUT',
    raw: true,
    body: buffer,
    headers: {
      'Content-Type': 'binary/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
    },
  });
}

// INTI "NO REPOSITORY": add_to_index = false — dokumen tidak diindeks
// ke repositori Turnitin dan tidak akan menjadi sumber pembanding di masa depan.
async function requestSimilarity(submissionId, opts) {
  return tca(`/submissions/${submissionId}/similarity`, {
    method: 'PUT',
    body: {
      indexing_settings: { add_to_index: false },
      generation_settings: {
        search_repositories: ['INTERNET', 'SUBMITTED_WORK', 'PUBLICATION', 'CROSSREF', 'CROSSREF_POSTED_CONTENT'],
        auto_exclude_self_matching_scope: 'ALL',
      },
      view_settings: {
        exclude_quotes: !!opts.excludeQuotes,
        exclude_bibliography: !!opts.excludeBibliography,
        exclude_small_matches: 0,
      },
    },
  });
}

/* ---------------------------------------------------------------- *
 *  Mode demo (tanpa kredensial Turnitin)
 * ---------------------------------------------------------------- */

function startDemoJob(job) {
  job.demo = { score: 8 + Math.floor(Math.random() * 25) };
  setTimeout(() => { job.phase = 'PROCESSING'; }, 1200);
  setTimeout(() => { job.phase = 'SIMILARITY'; }, 4000);
  setTimeout(() => {
    job.phase = 'COMPLETE';
    const s = job.demo.score;
    job.result = {
      overall_match_percentage: s,
      internet_match_percentage: Math.max(0, s - 3),
      publication_match_percentage: Math.max(0, Math.round(s * 0.4)),
      submitted_works_match_percentage: Math.max(0, Math.round(s * 0.25)),
    };
  }, 8000);
}

/* ---------------------------------------------------------------- *
 *  Endpoint API
 * ---------------------------------------------------------------- */

app.get('/api/config', (_req, res) => {
  res.json({ demo: DEMO_MODE });
});

app.post('/api/check', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return res.status(400).json({ error: `Tipe file ${ext || '(tanpa ekstensi)'} tidak didukung.` });
    }

    const options = {
      excludeQuotes: req.body.excludeQuotes === 'true',
      excludeBibliography: req.body.excludeBibliography === 'true',
    };

    const job = {
      filename: req.file.originalname,
      size: req.file.size,
      options,
      phase: 'UPLOADED',     // UPLOADED -> PROCESSING -> SIMILARITY -> COMPLETE | ERROR
      simRequested: false,
      result: null,
      error: null,
      createdAt: Date.now(),
    };

    if (DEMO_MODE) {
      const id = 'demo-' + crypto.randomUUID();
      jobs.set(id, job);
      startDemoJob(job);
      return res.json({ id, demo: true });
    }

    const submission = await createSubmission(req.file.originalname);
    await uploadFile(submission.id, req.file.originalname, req.file.buffer);
    job.phase = 'PROCESSING';
    jobs.set(submission.id, job);
    res.json({ id: submission.id, demo: false });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Gagal mengirim ke Turnitin: ' + err.message });
  }
});

app.get('/api/status/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Pekerjaan tidak ditemukan.' });

  if (DEMO_MODE || req.params.id.startsWith('demo-')) {
    return res.json({ phase: job.phase, filename: job.filename, result: job.result, error: job.error, demo: true });
  }

  try {
    if (job.phase === 'PROCESSING' || job.phase === 'UPLOADED') {
      const sub = await tca(`/submissions/${req.params.id}`);
      if (sub.status === 'ERROR') {
        job.phase = 'ERROR';
        job.error = `Turnitin gagal memproses file (kode: ${sub.error_code || 'tidak diketahui'}).`;
      } else if (sub.status === 'COMPLETE' && !job.simRequested) {
        await requestSimilarity(req.params.id, job.options);
        job.simRequested = true;
        job.phase = 'SIMILARITY';
      }
    }

    if (job.phase === 'SIMILARITY') {
      const sim = await tca(`/submissions/${req.params.id}/similarity`);
      if (sim.status === 'COMPLETE') {
        job.phase = 'COMPLETE';
        job.result = {
          overall_match_percentage: sim.overall_match_percentage ?? 0,
          internet_match_percentage: sim.internet_match_percentage ?? null,
          publication_match_percentage: sim.publication_match_percentage ?? null,
          submitted_works_match_percentage: sim.submitted_works_match_percentage ?? null,
        };
      }
    }

    res.json({ phase: job.phase, filename: job.filename, result: job.result, error: job.error, demo: false });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Gagal memeriksa status: ' + err.message });
  }
});

app.post('/api/viewer/:id', async (req, res) => {
  if (DEMO_MODE || req.params.id.startsWith('demo-')) {
    return res.status(400).json({ error: 'Viewer Turnitin tidak tersedia dalam mode demo.' });
  }
  try {
    const out = await tca(`/submissions/${req.params.id}/viewer-url`, {
      method: 'POST',
      body: {
        viewer_user_id: OWNER_ID,
        locale: 'id',
        viewer_default_permission_set: 'INSTRUCTOR',
        similarity: { default_mode: 'match_overview' },
      },
    });
    res.json({ url: out.viewer_url });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Gagal membuat URL viewer: ' + err.message });
  }
});

app.get('/api/pdf/:id', async (req, res) => {
  if (DEMO_MODE || req.params.id.startsWith('demo-')) {
    return res.status(400).json({ error: 'PDF tidak tersedia dalam mode demo.' });
  }
  try {
    const { id: pdfId } = await tca(`/submissions/${req.params.id}/similarity/pdf`, {
      method: 'POST',
      body: { locale: 'en-US' },
    });

    // Tunggu PDF selesai dibuat (maks ~60 detik)
    for (let i = 0; i < 30; i++) {
      const st = await tca(`/submissions/${req.params.id}/similarity/pdf/${pdfId}/status`);
      if (st.status === 'SUCCESS') break;
      if (st.status === 'FAILED') throw new Error('Pembuatan PDF gagal di sisi Turnitin.');
      await new Promise((r) => setTimeout(r, 2000));
    }

    const buf = await tca(`/submissions/${req.params.id}/similarity/pdf/${pdfId}`, { raw: 'buffer' });
    const job = jobs.get(req.params.id);
    const base = job ? path.parse(job.filename).name : req.params.id;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="laporan-similarity-${base}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Gagal mengunduh PDF: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cek Plagiasi berjalan di http://localhost:${PORT}`);
  console.log(DEMO_MODE
    ? '>> MODE DEMO aktif (TCA_BASE_URL / TCA_API_KEY belum diisi di .env)'
    : `>> Terhubung ke Turnitin: ${BASE} (NO REPOSITORY: add_to_index=false)`);
});
