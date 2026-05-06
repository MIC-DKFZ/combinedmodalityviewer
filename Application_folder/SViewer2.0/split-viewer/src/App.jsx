import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, ChevronDown, ChevronUp, ArrowLeft, Tv2, MousePointerClick } from 'lucide-react';

// --- Configuration ---
const DCM4CHEE_CONFIG = {
  baseUrl: 'http://localhost:8080/dcm4chee-arc',
  aeTitle: 'DCM4CHEE',
};

const VIEWERS_CONFIG = {
  ohif: '/viewer/',
  slim: 'http://localhost:8008/',
};

const STUDIES_URL = `${DCM4CHEE_CONFIG.baseUrl}/aets/${DCM4CHEE_CONFIG.aeTitle}/rs/studies`;

// --- Reusable Components ---
const SearchInput = ({ value, onChange, placeholder }) => (
  <div className="relative w-full md:w-1/3">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow text-black"
    />
  </div>
);

const TableHeader = ({ children, sortable, sorted, direction, onSort, className = '' }) => (
  <th
    className={`p-4 text-left font-semibold text-gray-600 uppercase tracking-wider ${
      sortable ? 'cursor-pointer hover:bg-gray-100' : ''
    } ${className}`}
    onClick={sortable ? onSort : undefined}
  >
    <div className="flex items-center">
      {children}
      {sortable && (
        <span className="ml-2">
          {sorted ? (
            direction === 'asc' ? (
              <ChevronUp size={16} />
            ) : (
              <ChevronDown size={16} />
            )
          ) : (
            <ChevronDown size={16} className="text-gray-300" />
          )}
        </span>
      )}
    </div>
  </th>
);

// --- Split View Component ---
const SplitView = ({ study, studies, onBack }) => {
  const [showSlim, setShowSlim] = useState(false);
  const [splitRatio, setSplitRatio] = useState(50);
  const [smSeriesInstanceUID, setSmSeriesInstanceUID] = useState(null);

  const ohifRef = useRef(null);
  const glassRef = useRef(null);

  // find the SM study for this patient
  const smStudy = useMemo(
    () => studies.find((s) => s.patientId === study.patientId && s.modality === 'SM'),
    [studies, study.patientId]
  );

  // when showSlim flips true, QIDO-RS the SM study's series list
  useEffect(() => {
    if (!showSlim || !smStudy) return;

    fetch(
      `${DCM4CHEE_CONFIG.baseUrl}/aets/${DCM4CHEE_CONFIG.aeTitle}` +
        `/rs/studies/${smStudy.id}/series?includefield=all`
    )
      .then((r) => r.json())
      .then((seriesList) => {
        if (seriesList.length > 0) {
          const uid = seriesList[0]['0020000E'].Value[0];
          setSmSeriesInstanceUID(uid);
        }
      })
      .catch((err) => console.error('Failed to load SM series:', err));
  }, [showSlim, smStudy]);

  // existing segmentation-scan logic
  useEffect(() => {
    const iframe = ohifRef.current;
    const overlayRoot = glassRef.current;
    if (!iframe || !overlayRoot) return;

    const scanCanvas = () => {
      const iframe = ohifRef.current;
      const hotBoxContainer = glassRef.current;
      if (!iframe || !hotBoxContainer) return;

      const doc = iframe.contentDocument;
      const canvas = doc?.querySelector('canvas.cornerstone-canvas');
      if (!canvas) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;

      const COLOR_VARIANCE_THRESHOLD = 12;
      const SIGNATURE_TOLERANCE = 40;
      const LUMINANCE_BLACK = 10;
      const LUMINANCE_WHITE = 245;

      const buildDescriptor = (r, g, b) => {
        const avg = (r + g + b) / 3;
        return {
          rgb: [r, g, b],
          signature: [r - avg, g - avg, b - avg],
        };
      };

      const getColorDescriptor = ([r, g, b, a]) => {
        if (a === 0) return null;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < COLOR_VARIANCE_THRESHOLD) return null; // grayscale (including black/white)
        if (max < LUMINANCE_BLACK) return null; // near black
        if (min > LUMINANCE_WHITE) return null; // near white
        return buildDescriptor(r, g, b);
      };

      const signatureDistance = (sigA, sigB) =>
        Math.abs(sigA[0] - sigB[0]) + Math.abs(sigA[1] - sigB[1]) + Math.abs(sigA[2] - sigB[2]);

      const matchesRegionColor = (pixel, baseDescriptor) => {
        const descriptor = getColorDescriptor(pixel);
        if (!descriptor) return null;
        return signatureDistance(descriptor.signature, baseDescriptor.signature) <= SIGNATURE_TOLERANCE
          ? descriptor
          : null;
      };

      const visited = new Uint8Array(width * height);
      const stride = 4;
      const segments = [];

      const floodFill = (x, y, id, baseDescriptor) => {
        const stack = [{ x, y }];
        let minX = x, minY = y, maxX = x, maxY = y;
        while (stack.length) {
          const { x, y } = stack.pop();
          const idx = y * width + x;
          if (visited[idx]) continue;
          const pixel = data.subarray(idx * 4, idx * 4 + 4);
          const descriptor = matchesRegionColor(pixel, baseDescriptor);
          if (!descriptor) continue;
          visited[idx] = id;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          if (x > 0) stack.push({ x: x - 1, y });
          if (x < width - 1) stack.push({ x: x + 1, y });
          if (y > 0) stack.push({ x, y: y - 1 });
          if (y < height - 1) stack.push({ x, y: y + 1 });
        }
        return { minX, minY, maxX, maxY };
      };

      let regionId = 1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += stride) {
          const idx = y * width + x;
          if (visited[idx]) continue;
          const pixel = data.subarray(idx * 4, idx * 4 + 4);
          const descriptor = getColorDescriptor(pixel);
          if (descriptor) {
            const box = floodFill(x, y, regionId++, descriptor);
            segments.push({ ...box, color: descriptor.rgb });
            console.log(
              '[SplitViewer] Detected colored segment',
              `rgb(${descriptor.rgb.join(',')})`,
              'bounds:',
              box
            );
          }
        }
      }

      const colorDistance = (c1, c2) =>
        Math.sqrt(
          (c1[0] - c2[0]) ** 2 +
          (c1[1] - c2[1]) ** 2 +
          (c1[2] - c2[2]) ** 2
        );

      const overlapRatio = (a, b) => {
        const left = Math.max(a.minX, b.minX);
        const right = Math.min(a.maxX, b.maxX);
        const top = Math.max(a.minY, b.minY);
        const bottom = Math.min(a.maxY, b.maxY);
        if (right <= left || bottom <= top) return 0;
        const intersection = (right - left) * (bottom - top);
        const minArea =
          Math.min(
            (a.maxX - a.minX) * (a.maxY - a.minY),
            (b.maxX - b.minX) * (b.maxY - b.minY)
          ) || 1;
        return intersection / minArea;
      };

      const mergedSegments = [];
      const MERGE_COLOR_THRESHOLD = 45;
      const MERGE_OVERLAP_THRESHOLD = 0.4;
      const SUPPRESS_OVERLAP_THRESHOLD = 0.65;

      segments
        .sort(
          (a, b) =>
            (b.maxX - b.minX) * (b.maxY - b.minY) -
            (a.maxX - a.minX) * (a.maxY - a.minY)
        )
        .forEach(segment => {
          let mergedIntoExisting = false;
          for (const existing of mergedSegments) {
            if (
              colorDistance(segment.color, existing.color) <= MERGE_COLOR_THRESHOLD &&
              overlapRatio(segment, existing) >= MERGE_OVERLAP_THRESHOLD
            ) {
              existing.minX = Math.min(existing.minX, segment.minX);
              existing.minY = Math.min(existing.minY, segment.minY);
              existing.maxX = Math.max(existing.maxX, segment.maxX);
              existing.maxY = Math.max(existing.maxY, segment.maxY);
              mergedIntoExisting = true;
              break;
            }
          }
          if (!mergedIntoExisting) {
            const overlapsLarger = mergedSegments.some(existing =>
              overlapRatio(segment, existing) >= SUPPRESS_OVERLAP_THRESHOLD
            );
            if (!overlapsLarger) {
              mergedSegments.push({ ...segment });
            }
          }
        });

      // Clear previous overlays
      hotBoxContainer.querySelectorAll('.seg-overlay').forEach(el => el.remove());

      const iframeRect = iframe.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const containerRect = hotBoxContainer.getBoundingClientRect();
      const scaleX = canvasRect.width / width;
      const scaleY = canvasRect.height / height;

      // canvas.getBoundingClientRect() is in iframe-local coords; add iframe offset to get main-page coords
      const canvasPageLeft = iframeRect.left + canvasRect.left;
      const canvasPageTop = iframeRect.top + canvasRect.top;

      const rgba = (color, alpha) => `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;

      mergedSegments.forEach(({ minX, minY, maxX, maxY, color }, i) => {
        const screenLeft = canvasPageLeft - containerRect.left + minX * scaleX;
        const screenTop = canvasPageTop - containerRect.top + minY * scaleY;
        const boxWidth = (maxX - minX) * scaleX;
        const boxHeight = (maxY - minY) * scaleY;

        const div = document.createElement('div');
        div.className = 'seg-overlay';
        Object.assign(div.style, {
          position: 'absolute',
          border: `2px dashed ${rgba(color, 0.8)}`,
          background: rgba(color, 0.25),
          left: `${screenLeft}px`,
          top: `${screenTop}px`,
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 9999,
        });

        // Add label
        const label = document.createElement('div');
        label.textContent = `#${i + 1}`;
        Object.assign(label.style, {
          position: 'absolute',
          top: '2px',
          left: '4px',
          fontSize: '12px',
          fontWeight: 'bold',
          color: '#fff',
          textShadow: '1px 1px 2px black',
          pointerEvents: 'none',
        });
        div.appendChild(label);

        div.onclick = () => {
          setShowSlim(true);
        };

        hotBoxContainer.appendChild(div);
      });
    };

    const win = iframe.contentWindow;
    let disposer = null;
    if (win && win.cornerstone && win.cornerstone.events) {
      const ev = win.cornerstone.events;
      ev.addEventListener('cornerstoneimagerendered', scanCanvas);
      disposer = () => ev.removeEventListener('cornerstoneimagerendered', scanCanvas);
    } else if (win && win.cs3DState) {
      win.cs3DState.addEventListener('IMAGE_RENDERED', scanCanvas);
      disposer = () => win.cs3DState.removeEventListener('IMAGE_RENDERED', scanCanvas);
    } else {
      const id = setInterval(scanCanvas, 500);
      disposer = () => clearInterval(id);
    }

    setTimeout(scanCanvas, 400);
    return disposer;
  }, []);

  if (!study) return null;

  const ohifUrl = `${VIEWERS_CONFIG.ohif}viewer?StudyInstanceUIDs=${study.id}`;
  const slimUrl =
    smSeriesInstanceUID &&
    `${VIEWERS_CONFIG.slim}studies/${smStudy.id}/series/${smSeriesInstanceUID}`;

  // for testing: just flip showSlim (real OHIF should send postMessage)
  const simulateMessageFromOhif = () => {
    setShowSlim(true);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-800">
      <header className="flex-shrink-0 bg-gray-900 text-white p-3 flex items-center justify-between shadow-lg space-x-4">
        <div className="flex items-center space-x-2 flex-shrink-0">
          <button
            onClick={onBack}
            className="flex items-center rounded-md transition-colors"
            style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', fontWeight: 600, border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.background = '#1d4ed8'}
            onMouseLeave={e => e.currentTarget.style.background = '#2563eb'}
          >
            <ArrowLeft size={20} className="mr-2" />
            Back
          </button>
          {!showSlim && (
            <button
              onClick={simulateMessageFromOhif}
              className="flex items-center rounded-md transition-colors"
              style={{ padding: '8px 16px', background: '#eab308', color: '#000', fontWeight: 600, border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = '#ca8a04'}
              onMouseLeave={e => e.currentTarget.style.background = '#eab308'}
            >
              <MousePointerClick size={20} className="mr-2" />
              Simulate SEG Click
            </button>
          )}
          {showSlim && (
            <button
              onClick={() => {
                setShowSlim(false);
                setSmSeriesInstanceUID(null);
              }}
              className="flex items-center rounded-md transition-colors"
              style={{ padding: '8px 16px', background: '#0d9488', color: '#fff', fontWeight: 600, border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = '#0f766e'}
              onMouseLeave={e => e.currentTarget.style.background = '#0d9488'}
            >
              <Tv2 size={20} className="mr-2" />
              Hide SLIM
            </button>
          )}
        </div>

        <div className="flex-grow flex items-center justify-center min-w-0 px-4">
          {showSlim && (
            <input
              type="range"
              min="10"
              max="90"
              value={splitRatio}
              onChange={(e) => setSplitRatio(+e.target.value)}
              className="w-1/2 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
              title={`Adjust split (${splitRatio}%)`}
            />
          )}
        </div>

        <div className="text-right flex-shrink-0" style={{ width: '250px' }}>
          <div className="font-semibold text-white truncate">{study.patientName}</div>
          <div className="text-xs text-gray-400">
            <span>ID: {study.patientId}</span>
            <span className="mx-2">|</span>
            <span>Date: {study.studyDate}</span>
          </div>
        </div>
      </header>

      <main className="flex-grow flex w-full h-full overflow-hidden">
        {showSlim && slimUrl && (
          <div className="h-full border-r-2 border-gray-700" style={{ width: `${100 - splitRatio}%` }}>
            <iframe src={slimUrl} title="SLIM Viewer" className="w-full h-full border-0" />
          </div>
        )}
        <div className="h-full transition-all duration-200 ease-in-out" style={{ width: showSlim ? `${splitRatio}%` : '100%' }}>
          <iframe ref={ohifRef} src={ohifUrl} title="OHIF Viewer" className="w-full h-full border-0" />

          <div ref={glassRef} className="absolute inset-0" style={{ pointerEvents: 'none' }} />
        </div>
      </main>
    </div>
  );
};

// --- Segmentation Log Modal ---
const SegModal = ({ log, status, studyLabel, onClose }) => {
  const logEndRef = useRef(null);
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  if (!status) return null;
  const running = status === 'running';
  const done    = status === 'done';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ background: '#1a1a2e', borderRadius: '14px', width: '740px', maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 30px 60px rgba(0,0,0,0.6)', border: '1px solid #2d2d4e' }}>

        {/* header bar */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #2d2d4e', display: 'flex', alignItems: 'center', gap: '12px', background: '#16213e', borderRadius: '14px 14px 0 0' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840' }} />
          </div>
          <span style={{ color: '#8b8baa', fontSize: '13px', fontFamily: 'monospace', flex: 1, textAlign: 'center' }}>
            TotalSegmentator — {studyLabel}
          </span>
          {running
            ? <div style={{ width: 18, height: 18, border: '2px solid #4f6ef7', borderTopColor: 'transparent', borderRadius: '50%', animation: '_spin 0.8s linear infinite' }} />
            : <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #444', color: '#aaa', borderRadius: '6px', padding: '2px 10px', cursor: 'pointer', fontSize: '13px' }}>Close</button>
          }
        </div>

        {/* status badge */}
        <div style={{ padding: '8px 20px', background: '#0f3460', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {running && <span style={{ color: '#60a5fa', fontSize: '13px', fontWeight: 600 }}>● Running…</span>}
          {done    && <span style={{ color: '#4ade80', fontSize: '13px', fontWeight: 600 }}>✔ Completed</span>}
          {status === 'error' && <span style={{ color: '#f87171', fontSize: '13px', fontWeight: 600 }}>✘ Failed</span>}
        </div>

        {/* log output */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', fontFamily: "'Menlo','Monaco','Consolas',monospace", fontSize: '13px', lineHeight: '1.6', color: '#c8d3f5', background: '#1a1a2e' }}>
          {log.map((line, i) => {
            const isErr  = /error|fail|exception/i.test(line);
            const isWarn = /warn/i.test(line);
            const isDone = /✔|success|complet/i.test(line);
            const color  = isErr ? '#f87171' : isWarn ? '#fbbf24' : isDone ? '#4ade80' : '#c8d3f5';
            return (
              <div key={i} style={{ color, paddingBottom: '1px' }}>
                <span style={{ color: '#4f6ef7', userSelect: 'none' }}>{'>'} </span>{line}
              </div>
            );
          })}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
};

// --- Study List Component ---
const StudyList = ({ studies, onSelectStudy }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: 'studyDate', direction: 'desc' });
  const [busyUID, setBusyUID] = useState(null);
  const [segLog, setSegLog] = useState([]);
  const [segStatus, setSegStatus] = useState(null); // null | 'running' | 'done' | 'error'
  const [segLabel, setSegLabel] = useState('');

  const getStudyUID = (study) => study?.id ?? null;

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const appendLog = (line) => setSegLog((prev) => [...prev, line]);

  const runSegmentation = async (study) => {
    const studyUID = getStudyUID(study);
    if (!studyUID) {
      setSegLog(['Error: Missing StudyInstanceUID for this study.']);
      setSegStatus('error');
      return;
    }

    setSegLog([`Initializing segmentation for study ${studyUID} …`]);
    setSegStatus('running');
    setSegLabel(study.patientId || studyUID);
    setBusyUID(studyUID);

    try {
      const resp = await fetch('/api/segment/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mrStudyUID: studyUID }),
      });

      const contentType = resp.headers.get('content-type') || '';
      const isStream = contentType.includes('text/event-stream')
        || contentType.includes('text/plain')
        || contentType.includes('application/x-ndjson');

      if (isStream && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          lines.filter((l) => l.trim()).forEach((l) => appendLog(l));
        }
        if (buf.trim()) appendLog(buf);
        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        appendLog('✔ Segmentation completed successfully.');
        setSegStatus('done');
      } else {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.detail || data?.error || `Request failed (${resp.status})`);
        appendLog(`Body part : ${data?.bodyPart || 'unknown'}`);
        if (data?.sct) {
          appendLog(`SCT code  : ${data.sct.code} — ${data.sct.meaning}${data.sct.cid ? ` (CID ${data.sct.cid})` : ''}`);
        }
        appendLog(`SEG path  : ${data?.segPath || '(stored on server)'}`);
        appendLog('✔ Segmentation completed successfully.');
        setSegStatus('done');
      }
    } catch (e) {
      console.error(e);
      appendLog(`✘ ${e.message}`);
      setSegStatus('error');
    } finally {
      setBusyUID(null);
    }
  };

  const sortedAndFilteredStudies = useMemo(() => {
    return [...studies]
      .filter((study) =>
        Object.values(study).some((v) => String(v).toLowerCase().includes(searchTerm.toLowerCase()))
      )
      .sort((a, b) => {
        if (!sortConfig.key) return 0;
        if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1;
        if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
  }, [studies, searchTerm, sortConfig]);

  return (
    <div className="bg-gray-50 min-h-screen font-sans">
      <SegModal
        log={segLog}
        status={segStatus}
        studyLabel={segLabel}
        onClose={() => setSegStatus(null)}
      />
      <div className="w-full p-4 md:p-8">
        <header className="mb-8">
          <h1 className="text-4xl font-bold text-gray-800">Split-Viewer: Study List</h1>
          <p className="text-gray-500 mt-1">Viewing studies from local DCM4CHEE server.</p>
        </header>

        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <div className="p-4 md:p-6 border-b border-gray-200 flex justify-between items-center">
            <SearchInput value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search studies..." />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <TableHeader>Patient ID</TableHeader>
                  <TableHeader>Patient Name</TableHeader>
                  <TableHeader>Study Date</TableHeader>
                  <TableHeader>Modality</TableHeader>
                  <TableHeader>Description</TableHeader>
                  <TableHeader>Actions</TableHeader>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {sortedAndFilteredStudies.map((s) => {
                  const isBusy = busyUID === s.id;
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="p-4 whitespace-nowrap text-sm font-medium text-gray-800">{s.patientId}</td>
                      <td className="p-4 whitespace-nowrap text-sm text-gray-600">{s.patientName}</td>
                      <td className="p-4 whitespace-nowrap text-sm text-gray-600">{s.studyDate}</td>
                      <td className="p-4 whitespace-nowrap text-sm">
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                          {s.modality}
                        </span>
                      </td>
                      <td className="p-4 text-sm text-gray-600 max-w-xs truncate">{s.description}</td>
                      <td className="p-4 whitespace-nowrap text-sm font-medium" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          onClick={() => onSelectStudy(s)}
                          style={{ padding: '5px 14px', background: '#16a34a', color: '#fff', fontWeight: 600, fontSize: '13px', border: 'none', borderRadius: '6px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#15803d'}
                          onMouseLeave={e => e.currentTarget.style.background = '#16a34a'}
                        >
                          Open Viewer
                        </button>
                        <button
                          onClick={() => runSegmentation(s)}
                          disabled={isBusy}
                          title="Run TotalSegmentator and create DICOM SEG"
                          style={{ padding: '5px 14px', background: isBusy ? '#9ca3af' : '#059669', color: '#fff', fontWeight: 600, fontSize: '13px', border: 'none', borderRadius: '6px', cursor: isBusy ? 'not-allowed' : 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}
                          onMouseEnter={e => { if (!isBusy) e.currentTarget.style.background = '#047857'; }}
                          onMouseLeave={e => { if (!isBusy) e.currentTarget.style.background = '#059669'; }}
                        >
                          {isBusy ? 'Running…' : 'Segment (TS)'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <footer className="text-center mt-8 text-gray-400 text-sm">
          <p>Designed by Nilesh Parshotam Rijhwani (C140)</p>
        </footer>
      </div>
    </div>
  );
};

// --- Main App Component ---
export default function App() {
  const [studies, setStudies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentView, setCurrentView] = useState('list');
  const [selectedStudy, setSelectedStudy] = useState(null);

  const formatDicomDate = (dicomDate) => {
    if (!dicomDate || dicomDate.length !== 8) return 'N/A';
    return `${dicomDate.slice(0, 4)}-${dicomDate.slice(4, 6)}-${dicomDate.slice(6, 8)}`;
  };

  useEffect(() => {
    const fetchStudies = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${STUDIES_URL}?fuzzymatching=true&includefield=all`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const formatted = data.map((st) => {
          const getValue = (tag, def = 'N/A') => st[tag]?.Value?.[0] ?? def;
          return {
            id: getValue('0020000D'),
            patientId: getValue('00100020'),
            patientName: getValue('00100010')?.Alphabetic ?? 'N/A',
            studyDate: formatDicomDate(getValue('00080020')),
            modality: getValue('00080061'),
            description: getValue('00081030'),
          };
        });
        setStudies(formatted);
      } catch (e) {
        console.error(e);
        setError('Failed to fetch studies. Check console and DCM4CHEE server.');
      } finally {
        setLoading(false);
      }
    };
    fetchStudies();
  }, []);

  const handleSelectStudy = (st) => {
    setSelectedStudy(st);
    setCurrentView('split');
  };
  const handleBackToList = () => {
    setSelectedStudy(null);
    setCurrentView('list');
  };

  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (error) return <div className="flex items-center justify-center h-screen text-red-500">{error}</div>;
  if (currentView === 'split')
    return <SplitView study={selectedStudy} studies={studies} onBack={handleBackToList} />;
  return <StudyList studies={studies} onSelectStudy={handleSelectStudy} />;
}
