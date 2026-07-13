/* Cek Plagiasi — logika frontend */

const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const fileCard = $('fileCard');
const submitBtn = $('submitBtn');

let selectedFile = null;
let currentId = null;
let pollTimer = null;

/* ---------- Tanggal pada masthead ---------- */
$('today').textContent = new Date().toLocaleDateString('id-ID', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
}).toUpperCase();

/* ---------- Banner mode demo ---------- */
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => { if (cfg.demo) $('demoBanner').hidden = false; })
  .catch(() => {});

/* ---------- Pemilihan file ---------- */

const ALLOWED = ['.pdf', '.docx'];

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function setFile(file) {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED.includes(ext)) {
    showError('uploadError', `Tipe file ${ext} tidak didukung.`);
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    showError('uploadError', 'Ukuran file melebihi 100 MB.');
    return;
  }
  hideError('uploadError');
  selectedFile = file;
  $('fileName').textContent = file.name;
  $('fileSize').textContent = fmtSize(file.size).toUpperCase();
  fileCard.hidden = false;
  dropzone.style.display = 'none';
  submitBtn.disabled = false;
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  fileCard.hidden = true;
  dropzone.style.display = '';
  submitBtn.disabled = true;
}

$('browseBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
$('removeFile').addEventListener('click', clearFile);

['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

/* ---------- Kirim & pantau ---------- */

submitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MENGIRIM…';
  hideError('uploadError');

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('excludeQuotes', $('optQuotes').checked);
  form.append('excludeBibliography', $('optBiblio').checked);

  try {
    const res = await fetch('/api/check', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengirim dokumen.');

    currentId = data.id;
    $('checkingFile').textContent = '» ' + selectedFile.name.toUpperCase();
    $('panelUpload').hidden = true;
    $('panelProgress').hidden = false;
    setStep('UPLOADED');
    poll();
  } catch (err) {
    showError('uploadError', err.message);
    submitBtn.disabled = false;
  } finally {
    submitBtn.innerHTML = 'MULAI PEMERIKSAAN <span class="arrow">→</span>';
  }
});

const STEP_ORDER = ['UPLOADED', 'PROCESSING', 'SIMILARITY', 'COMPLETE'];

function setStep(phase) {
  const idx = STEP_ORDER.indexOf(phase);
  document.querySelectorAll('.step').forEach((el) => {
    const i = STEP_ORDER.indexOf(el.dataset.step);
    el.classList.toggle('done', i < idx || phase === 'COMPLETE');
    el.classList.toggle('active', i === idx && phase !== 'COMPLETE');
  });
}

async function poll() {
  try {
    const res = await fetch('/api/status/' + currentId);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memeriksa status.');

    if (data.phase === 'ERROR') {
      showError('progressError', data.error || 'Terjadi kesalahan saat pemrosesan.');
      return;
    }

    setStep(data.phase);

    if (data.phase === 'COMPLETE' && data.result) {
      setTimeout(() => showResult(data.result, data.demo), 700);
      return;
    }
    pollTimer = setTimeout(poll, 3000);
  } catch (err) {
    showError('progressError', err.message + ' — mencoba lagi…');
    pollTimer = setTimeout(poll, 5000);
  }
}

/* ---------- Hasil ---------- */

function verdictFor(score) {
  if (score < 15) return 'Tingkat kemiripan rendah — naskah tergolong aman.';
  if (score < 25) return 'Kemiripan sedang — periksa kembali bagian yang cocok.';
  if (score < 40) return 'Kemiripan cukup tinggi — perlu parafrasa & sitasi ulang.';
  return 'Kemiripan tinggi — naskah perlu revisi besar.';
}

function showResult(result, isDemo) {
  $('panelProgress').hidden = true;
  $('panelResult').hidden = false;

  const score = Math.round(result.overall_match_percentage || 0);

  // Gauge
  const C = 527.8;
  const fill = $('gaugeFill');
  requestAnimationFrame(() => {
    fill.style.strokeDashoffset = C - (C * Math.min(score, 100)) / 100;
    fill.style.stroke = score < 15 ? 'var(--ok)' : score < 25 ? 'var(--warn)' : 'var(--stamp)';
  });

  // Angka berjalan (dengan fallback bila rAF tidak berjalan, mis. tab di latar belakang)
  const numEl = $('scoreNum');
  const t0 = performance.now();
  (function tick(now) {
    const p = Math.min((now - t0) / 1200, 1);
    numEl.textContent = Math.round(score * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
  setTimeout(() => { numEl.textContent = score; }, 1300);

  $('verdict').textContent = verdictFor(score);

  // Rincian sumber
  const parts = [
    ['Internet', result.internet_match_percentage],
    ['Publikasi', result.publication_match_percentage],
    ['Karya terkirim lain', result.submitted_works_match_percentage],
  ].filter(([, v]) => v !== null && v !== undefined);

  $('breakdown').innerHTML = parts.map(([label, v]) => `
    <li>
      <div class="bd-row"><span>${label}</span><span>${Math.round(v)}%</span></div>
      <div class="bd-bar"><div class="bd-fill" data-w="${Math.min(v, 100)}"></div></div>
    </li>`).join('');

  requestAnimationFrame(() =>
    document.querySelectorAll('.bd-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; }));

  if (isDemo) {
    $('viewerBtn').disabled = true;
    $('pdfBtn').disabled = true;
    showError('resultError', 'Mode demo: laporan Turnitin asli & PDF hanya tersedia dengan API key.');
  }
}

/* ---------- Aksi hasil ---------- */

$('viewerBtn').addEventListener('click', async () => {
  hideError('resultError');
  try {
    const res = await fetch('/api/viewer/' + currentId, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    window.open(data.url, '_blank', 'noopener');
  } catch (err) {
    showError('resultError', err.message);
  }
});

$('pdfBtn').addEventListener('click', async () => {
  hideError('resultError');
  const btn = $('pdfBtn');
  btn.disabled = true;
  btn.textContent = 'MENYIAPKAN PDF…';
  try {
    const res = await fetch('/api/pdf/' + currentId);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Gagal mengunduh PDF.');
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'laporan-similarity.pdf';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showError('resultError', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'UNDUH PDF';
  }
});

$('againBtn').addEventListener('click', () => {
  clearTimeout(pollTimer);
  currentId = null;
  clearFile();
  $('panelResult').hidden = true;
  $('panelUpload').hidden = false;
  $('viewerBtn').disabled = false;
  $('pdfBtn').disabled = false;
  hideError('resultError');
  hideError('progressError');
  $('gaugeFill').style.strokeDashoffset = 527.8;
  $('scoreNum').textContent = '0';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------- Util ---------- */

function showError(id, msg) { const el = $(id); el.textContent = msg; el.hidden = false; }
function hideError(id) { $(id).hidden = true; }
