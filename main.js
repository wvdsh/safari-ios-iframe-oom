// Spawn Web Workers that each allocate (and commit) a large ArrayBuffer,
// then loop on busy work. Memory pressure ramps until the renderer dies.

function clamp(n, lo, hi) {
	if (Number.isNaN(n)) return lo;
	return Math.max(lo, Math.min(hi, n));
}

const params = new URLSearchParams(location.search);
const MAX_WORKERS = clamp(parseInt(params.get('workers') ?? '60', 10), 1, 400);
const MB_PER_WORKER = clamp(parseInt(params.get('mb') ?? '120', 10), 1, 512);
const SPAWN_DELAY_MS = clamp(parseInt(params.get('delay') ?? '50', 10), 0, 10000);
// Default to auto-start so iOS sees a "broken from the moment I load" page
// and triggers the "A problem repeatedly occurred" panel after a few reloads.
const AUTO_START = params.get('auto') !== '0';

// "Persistent crash" mode: once started, set a sessionStorage flag so we
// resume crashing immediately after each iOS auto-reload. After 2-3 such
// cycles iOS gives up and shows the "A problem repeatedly occurred" panel.
const PERSIST_KEY = 'wd.crashtest.persist';
const PERSIST = sessionStorage.getItem(PERSIST_KEY) === '1';

const statsEl = document.getElementById('stats');
const fillEl = document.getElementById('fill');
const startBtn = document.getElementById('start');

const errors = [];
const workers = [];
const lastWorkerHeartbeat = new Map();
let totalAllocatedMB = 0;
let crashing = false;

// Heartbeat from main thread. requestAnimationFrame is the right primitive —
// it stops cold when the renderer is killed; setInterval keeps firing from
// the timer queue and gives a false "still alive" signal.
function tickHeartbeat() {
	try {
		parent.postMessage({ type: 'wavedash.heartbeat', source: 'main', t: performance.now() }, '*');
	} catch {
		/* noop */
	}
	requestAnimationFrame(tickHeartbeat);
}
requestAnimationFrame(tickHeartbeat);

function render() {
	const workerLines = workers
		.map((_w, i) => {
			const last = lastWorkerHeartbeat.get(i);
			const ageMs = last ? (performance.now() - last).toFixed(0) : '—';
			return `  worker ${String(i).padStart(2, '0')}: last beat ${ageMs} ms ago`;
		})
		.join('\n');
	statsEl.textContent =
		`workers: ${workers.length} / ${MAX_WORKERS}\n` +
		`allocated: ~${totalAllocatedMB} MB\n` +
		`per worker: ${MB_PER_WORKER} MB\n` +
		`spawn delay: ${SPAWN_DELAY_MS} ms\n\n` +
		(workerLines || '  (no workers spawned yet)') +
		(errors.length ? '\n\nERRORS:\n' + errors.slice(-5).join('\n') : '');

	const targetMB = MAX_WORKERS * MB_PER_WORKER;
	const pct = targetMB > 0 ? Math.min(100, (totalAllocatedMB / targetMB) * 100) : 0;
	fillEl.style.width = pct + '%';
}

// Worker source inlined as a blob URL — sidesteps any dev-server MIME issues
// for separate .js files and works identically in `wavedash dev` and prod.
const WORKER_SOURCE = `
let buf = null, view = null;

self.onmessage = (e) => {
	const data = e.data;
	if (data && data.type === 'allocate') {
		const bytes = data.mb * 1024 * 1024;
		try {
			buf = new ArrayBuffer(bytes);
			view = new Uint8Array(buf);
			for (let i = 0; i < view.length; i += 4096) view[i] = (i ^ data.index) & 0xff;
			self.postMessage({ type: 'allocated', mb: data.mb, index: data.index });
			loop(data.index);
		} catch (err) {
			self.postMessage({ type: 'allocate-failed', error: String(err), index: data.index });
		}
	}
};

function loop(index) {
	let acc = 0;
	function tick() {
		const start = performance.now();
		while (performance.now() - start < 50) {
			for (let i = 0; i < 10000; i++) acc = Math.sin(acc + i) * 1e6;
		}
		if (view) {
			const off = Math.floor(Math.random() * Math.max(1, view.length - 4096));
			for (let i = 0; i < 4096; i += 64) view[off + i] = (acc | 0) & 0xff;
		}
		self.postMessage({ type: 'heartbeat', acc, index });
		setTimeout(tick, 0);
	}
	tick();
}
`;

const workerBlob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);

function spawnWorker(index) {
	let worker;
	try {
		worker = new Worker(workerUrl);
	} catch (err) {
		errors.push(`worker ${index} construct failed: ${err.message ?? err}`);
		render();
		return;
	}
	worker.onmessage = (e) => {
		const data = e.data;
		if (data?.type === 'allocated') {
			totalAllocatedMB += data.mb;
		} else if (data?.type === 'allocate-failed') {
			errors.push(`worker ${index} allocate failed: ${data.error}`);
		} else if (data?.type === 'heartbeat') {
			lastWorkerHeartbeat.set(index, performance.now());
		}
		render();
	};
	worker.onerror = (err) => {
		errors.push(
			`worker ${index} error: ${err.message ?? '(no message)'} @ ${err.filename ?? '?'}:${err.lineno ?? '?'}`
		);
		render();
	};
	worker.onmessageerror = (err) => {
		errors.push(`worker ${index} messageerror: ${err}`);
		render();
	};
	worker.postMessage({ type: 'allocate', mb: MB_PER_WORKER, index });
	workers.push(worker);
	render();
}

async function startCrash() {
	if (crashing) return;
	crashing = true;
	sessionStorage.setItem(PERSIST_KEY, '1');
	startBtn.disabled = true;
	startBtn.textContent = 'crashing...';

	// Match Unity's "broken from the moment I load" pattern: spawn all
	// workers as fast as possible so the OOM hits within ~1s of load,
	// before iOS classifies the crash as user-initiated.
	if (AUTO_START || PERSIST) {
		for (let i = 0; i < MAX_WORKERS; i++) {
			spawnWorker(i);
		}
		render();
		return;
	}

	// Manual mode (button tap): keep the staggered spawn so you can watch
	// the bar fill up.
	for (let i = 0; i < MAX_WORKERS; i++) {
		spawnWorker(i);
		render();
		await new Promise((r) => setTimeout(r, SPAWN_DELAY_MS));
	}
	statsEl.textContent += '\n\nAll workers spawned. If you can read this, your device survived 🎉';
	render();
}

function stopCrashing() {
	sessionStorage.removeItem(PERSIST_KEY);
	location.reload();
}
window.stopCrashing = stopCrashing;

startBtn.addEventListener('click', startCrash);

render();

if (AUTO_START || PERSIST) startCrash();
