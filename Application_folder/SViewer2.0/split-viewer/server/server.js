// server.js
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { finished } from "stream/promises";
import axios from "axios";
import child_process from "child_process";
import util from "util";
import unzipper from "unzipper";

const exec = util.promisify(child_process.exec);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});

// ==== ENV / CONFIG ====
// Prefer internal service name for dcm4chee when running in compose: http://arc:8080/dcm4chee-arc
const DCM4CHEE_BASE = process.env.DCM4CHEE_BASE || "http://arc:8080/dcm4chee-arc";
const AET = process.env.AET || "DCM4CHEE";
const BEARER = process.env.DCM4CHEE_TOKEN || null;
const MASTER_PATH = process.env.ANATOMIC_MASTER_JSON || "/app/dicom_anatomic_master.json";

// ==== Small logging helpers ====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);

// ==== HTTP header helper ====
function arcHeaders(accept = "application/json") {
  const h = { Accept: accept };
  if (BEARER) h.Authorization = `Bearer ${BEARER}`;
  return h;
}

// ==== Stream / FS helpers ====
async function saveStreamToFile(readable, outPath) {
  const ws = fs.createWriteStream(outPath);
  readable.pipe(ws);
  await finished(ws);
  return outPath;
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}_`));
}
async function unzipTo(zipPath, outDir) {
  await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: outDir })).promise();
  return outDir;
}
function findFileRecursive(root, predicate) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (!predicate || predicate(p, name)) return p;
    }
  }
  return null;
}
function listFilesRecursive(root, predicate) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (!predicate || predicate(p, name)) out.push(p);
    }
  }
  return out;
}

// ==== QIDO helpers ====
async function qidoStudies(params) {
  const url = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies`;
  const res = await axios.get(url, { params, headers: arcHeaders() });
  return res.data;
}
async function qidoSeries(studyUID, params) {
  const url = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies/${encodeURIComponent(
    studyUID
  )}/series`;
  const res = await axios.get(url, { params, headers: arcHeaders() });
  return res.data;
}
async function qidoInstances(studyUID, seriesUID, params) {
  const url = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies/${encodeURIComponent(
    studyUID
  )}/series/${encodeURIComponent(seriesUID)}/instances`;
  const res = await axios.get(url, { params, headers: arcHeaders() });
  return res.data;
}

// ==== DICOM JSON accessors ====
function getAttr(item, tag) {
  return item?.[tag];
}
function getValue(item, tag, def = undefined) {
  const a = getAttr(item, tag);
  if (!a) return def;
  const v = a.Value;
  if (!Array.isArray(v) || v.length === 0) return def;
  return v[0];
}
function getSeqArray(item, seqTag) {
  const a = getAttr(item, seqTag);
  if (!a) return [];
  const v = a.Value;
  return Array.isArray(v) ? v : [];
}
function getCodeMeaningFromSeqItems(seqItems) {
  for (const entry of seqItems) {
    const meaning = getValue(entry, "00080104"); // Code Meaning
    if (meaning) return meaning;
  }
  return undefined;
}

// ==== TOTALSEG body-part normalization ====
const BODY_PART_TO_TS_CANON = {
  heart: "heart",
  liver: "liver",
  spleen: "spleen",
  kidney: "kidney",
  kidneys: "kidney",
  lung: "lung",
  lungs: "lung",
  aorta: "aorta",
  brain: "brain",
  prostate: "prostate",
};
function normalizeBodyPart(value) {
  if (!value) return undefined;
  const v = String(value).toLowerCase();
  const simple = v.replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (BODY_PART_TO_TS_CANON[simple]) return BODY_PART_TO_TS_CANON[simple];
  for (const key of Object.keys(BODY_PART_TO_TS_CANON)) {
    if (simple.includes(key)) return BODY_PART_TO_TS_CANON[key];
  }
  if (simple.includes("carcinoma of prostate") || simple.includes("prostate carcinoma"))
    return "prostate";
  return undefined;
}
function inferBodyFromItem(item, level) {
  // BodyPartExamined (0018,0015)
  const bpe = getValue(item, "00180015");
  let mapped = normalizeBodyPart(bpe);
  if (mapped) return { bodyPart: mapped, source: { tag: "00180015", value: bpe, which: level } };

  // Anatomic Region Sequence (0008,2218)
  const arsItems = getSeqArray(item, "00082218");
  const arsMeaning = getCodeMeaningFromSeqItems(arsItems);
  mapped = normalizeBodyPart(arsMeaning);
  if (mapped) return { bodyPart: mapped, source: { tag: "00082218(CodeMeaning)", value: arsMeaning, which: level } };

  // Admitting Diagnoses Code Seq (0008,1084)
  const adxItems = getSeqArray(item, "00081084");
  const adxMeaning = getCodeMeaningFromSeqItems(adxItems);
  mapped = normalizeBodyPart(adxMeaning);
  if (mapped) return { bodyPart: mapped, source: { tag: "00081084(CodeMeaning)", value: adxMeaning, which: level } };

  // Descriptions fallbacks
  const studyDesc = getValue(item, "00081030");
  mapped = normalizeBodyPart(studyDesc);
  if (mapped) return { bodyPart: mapped, source: { tag: "00081030", value: studyDesc, which: level } };

  const seriesDesc = getValue(item, "0008103E");
  mapped = normalizeBodyPart(seriesDesc);
  if (mapped) return { bodyPart: mapped, source: { tag: "0008103E", value: seriesDesc, which: level } };

  const admittingDesc = getValue(item, "00081080");
  mapped = normalizeBodyPart(admittingDesc);
  if (mapped) return { bodyPart: mapped, source: { tag: "00081080", value: admittingDesc, which: level } };

  const reqProcDesc = getValue(item, "00321060");
  mapped = normalizeBodyPart(reqProcDesc);
  if (mapped) return { bodyPart: mapped, source: { tag: "00321060", value: reqProcDesc, which: level } };

  const reasonForStudy = getValue(item, "00321030");
  mapped = normalizeBodyPart(reasonForStudy);
  if (mapped) return { bodyPart: mapped, source: { tag: "00321030", value: reasonForStudy, which: level } };

  const protocolName = getValue(item, "00181030");
  mapped = normalizeBodyPart(protocolName);
  if (mapped) return { bodyPart: mapped, source: { tag: "00181030", value: protocolName, which: level } };

  return null;
}

// ==== MASTER DATA LOAD (your JSON shape) ====
// Indices: code -> entry, meaningLower -> [entries]
let MASTER_BY_CODE = {};
let MASTER_BY_MEANING = new Map();

function addToIndices(entry) {
  if (!entry?.code || !entry?.meaning) return;
  MASTER_BY_CODE[entry.code] = { ...entry };
  const key = String(entry.meaning).toLowerCase();
  if (!MASTER_BY_MEANING.has(key)) MASTER_BY_MEANING.set(key, []);
  const arr = MASTER_BY_MEANING.get(key);
  if (!arr.find((e) => e.code === entry.code)) arr.push({ ...entry });
}
function parseUserMasterJson(rawObj) {
  MASTER_BY_CODE = {};
  MASTER_BY_MEANING = new Map();
  const root = rawObj?.dicom_anatomic_master;
  if (!root) throw new Error("Missing dicom_anatomic_master root");
  const parseCID = (cidKey) => {
    const cidObj = root[cidKey];
    if (!cidObj) return;
    const table = cidObj.table || [];
    for (const row of table) {
      if (row.row_type === "include") continue;
      const scheme = row.coding_scheme_designator || row.scheme;
      const code = row.code_value || row.code;
      const meaning = row.code_meaning || row.meaning;
      if (String(scheme).toUpperCase() !== "SCT") continue;
      addToIndices({
        cid: cidKey.replace("CID_", ""),
        scheme: "SCT",
        code: String(code),
        meaning: String(meaning),
      });
    }
  };
  parseCID("CID_4030");
  parseCID("CID_4031");
  if (!Object.keys(MASTER_BY_CODE).length) throw new Error("Parsed zero SCT rows from master JSON");
}
function loadMaster() {
  try {
    const raw = fs.readFileSync(MASTER_PATH, "utf8");
    const obj = JSON.parse(raw);
    parseUserMasterJson(obj);
    log(`Loaded anatomic master from ${MASTER_PATH} (codes: ${Object.keys(MASTER_BY_CODE).length})`);
  } catch (e) {
    warn("Failed to load/parse master JSON:", e.message);
    MASTER_BY_CODE = {};
    MASTER_BY_MEANING = new Map();
  }
}
function lookupSCTByBodyPart(bodyPart) {
  if (!bodyPart) return null;
  const normalized = String(bodyPart).toLowerCase();
  if (MASTER_BY_MEANING.has(normalized)) {
    const list = MASTER_BY_MEANING.get(normalized);
    return list.find((e) => e.cid === "4031") || list[0];
  }
  for (const [m, list] of MASTER_BY_MEANING.entries()) {
    if (m.includes(normalized) || normalized.includes(m)) {
      return list.find((e) => e.cid === "4031") || list[0];
    }
  }
  return null;
}
loadMaster();

// ==== TotalSegmentator map & colors ====
const TS_LABEL_KEY = {
  heart: "heart",
  liver: "liver",
  spleen: "spleen",
  kidney: "kidney", // may be kidney_left/right in outputs
  lung: "lung",     // may be lung_left/right in outputs
  aorta: "aorta",
  brain: "brain",
  prostate: "prostate",
};
const DISPLAY_RGB = {
  heart: [206, 110, 84],
  liver: [170, 120, 45],
  spleen: [220, 50, 50],
  kidney: [130, 200, 255],
  lung: [100, 180, 255],
  aorta: [255, 180, 60],
  brain: [160, 120, 200],
  prostate: [240, 160, 60],
};

// ====== Routes ======

// Health
app.get("/api/ping", (_req, res) =>
  res.json({
    ok: true,
    base: DCM4CHEE_BASE,
    aet: AET,
    masterCodes: Object.keys(MASTER_BY_CODE).length,
  })
);

// Milestone 1: download study as ZIP to /tmp
// POST /api/segment/start { studyUID }
app.post("/api/segment/start", async (req, res) => {
  try {
    const { studyUID } = req.body || {};
    if (!studyUID) return res.status(400).json({ error: "studyUID is required" });

    const url = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies/${encodeURIComponent(
      studyUID
    )}?dicomdir=true`;

    const response = await axios.get(url, {
      responseType: "stream",
      headers: arcHeaders("application/zip"),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const tmpZip = path.join(
      os.tmpdir(),
      `study_${studyUID.replace(/[^\w.-]/g, "_")}_${Date.now()}.zip`
    );
    await saveStreamToFile(response.data, tmpZip);
    log(`✅ Downloaded study ZIP → ${tmpZip}`);

    return res.json({ status: "ok", studyUID, zipPath: tmpZip });
  } catch (err) {
    console.error(err?.response?.status, err?.response?.data || err);
    return res.status(500).json({
      error: "Failed to download study ZIP",
      detail: err?.message || String(err),
    });
  }
});

// Milestone 2: infer body part + SCT from SM for same patient as MR
// POST /api/segment/find-bodypart { mrStudyUID }
app.post("/api/segment/find-bodypart", async (req, res) => {
  try {
    const { mrStudyUID } = req.body || {};
    if (!mrStudyUID) return res.status(400).json({ error: "mrStudyUID is required" });

    // MR → PatientID
    const mr = await qidoStudies({ StudyInstanceUID: mrStudyUID, includefield: "all", limit: 1 });
    if (!mr?.length) return res.status(404).json({ error: "MR/CT study not found" });
    const modality = (getValue(mr[0], "00080061") || "").toUpperCase();
    console.log("Modality:", modality);
    if (!["MR", "CT"].includes(modality)) {
      return res.status(400).json({ error: "Only MR/CT studies are supported", modality });
    }
    const patientID = getValue(mr[0], "00100020");
    if (!patientID) return res.status(404).json({ error: "MR/CT study missing PatientID" });

    // SM list
    const smStudies = await qidoStudies({
      PatientID: patientID,
      Modality: "SM",
      includefield: "all",
      limit: 10,
    });
    const smOnly = smStudies?.filter((s) => (getValue(s, "00080061") || "").toUpperCase() === "SM");
    if (!smOnly?.length) {
      return res.status(404).json({ error: "No SM studies found for this patient", patientID });
    }

    let bodyPart, chosen = { smStudyUID: null, smSeriesUID: null, level: null }, source = null;

    outer: for (const s of smOnly) {
      const smUID = getValue(s, "0020000D");
      let inf = inferBodyFromItem(s, "study");
      if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: null, level: "study" }; break; }

      const seriesList = await qidoSeries(smUID, { includefield: "all" });
      for (const se of seriesList) {
        const seUID = getValue(se, "0020000E");
        inf = inferBodyFromItem(se, "series");
        if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: seUID, level: "series" }; break outer; }
        const inst = await qidoInstances(smUID, seUID, { includefield: "all", limit: 1 });
        if (inst?.length) {
          inf = inferBodyFromItem(inst[0], "instance");
          if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: seUID, level: "instance" }; break outer; }
        }
      }
    }

    if (!bodyPart) {
      return res.status(404).json({
        error: "Could not infer body part from SM metadata",
        patientID,
        triedStudies: smOnly.map((s) => getValue(s, "0020000D")),
      });
    }

    const sct = lookupSCTByBodyPart(bodyPart);
    if (!sct) {
      return res.status(404).json({
        error: "Body part inferred, but no SCT code found in master",
        bodyPart,
      });
    }

    return res.json({
      status: "ok",
      mrStudyUID,
      bodyPart,
      sct, // { scheme:'SCT', code, meaning, cid }
      smStudyUID: chosen.smStudyUID,
      smSeriesUID: chosen.smSeriesUID,
      source,
    });
  } catch (err) {
    console.error(err?.response?.status, err?.response?.data || err);
    return res.status(500).json({
      error: "Failed to determine body part from SM",
      detail: err?.message || String(err),
    });
  }
});

// Milestone 3: Full pipeline to DICOM SEG using TotalSegmentator (total_mr)
// POST /api/segment/run { mrStudyUID, outDir? }
app.post("/api/segment/run", async (req, res) => {
  const t0 = Date.now();
  try {
    const { mrStudyUID, outDir } = req.body || {};
    if (!mrStudyUID) return res.status(400).json({ error: "mrStudyUID is required" });
    log("SEG_RUN: start", { mrStudyUID });

    // 1) MR -> PatientID
    const mr = await qidoStudies({ StudyInstanceUID: mrStudyUID, includefield: "all", limit: 1 });
    if (!mr?.length) {
      log("SEG_RUN: MR lookup failed");
      return res.status(404).json({ error: "MR/CT study not found" });
    }
    const modality = (getValue(mr[0], "00080061") || "").toUpperCase();
    if (!["MR", "CT"].includes(modality)) {
      log("SEG_RUN: unsupported modality", modality);
      return res.status(400).json({ error: "Only MR/CT studies are supported", modality });
    }
    const patientID = getValue(mr[0], "00100020");
    if (!patientID) {
      log("SEG_RUN: MR/CT study missing PatientID");
      return res.status(404).json({ error: "MR/CT study missing PatientID" });
    }
    log("SEG_RUN: MR resolved", { patientID, modality });

    // Find SM & infer body part
    log("SEG_RUN: querying SM studies");
    const smStudies = await qidoStudies({ PatientID: patientID, Modality: "SM", includefield: "all", limit: 10 });
    const smOnly = smStudies?.filter((s) => (getValue(s, "00080061") || "").toUpperCase() === "SM");
    if (!smOnly?.length) {
      log("SEG_RUN: no SM studies", { patientID });
      return res.status(404).json({ error: "No SM studies found for this patient", patientID });
    }

    let bodyPart, chosen = { smStudyUID: null, smSeriesUID: null, level: null }, source = null;
    outer: for (const s of smOnly) {
      const smUID = getValue(s, "0020000D");
      let inf = inferBodyFromItem(s, "study");
      if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: null, level: "study" }; break; }
      const seriesList = await qidoSeries(smUID, { includefield: "all" });
      for (const se of seriesList) {
        const seUID = getValue(se, "0020000E");
        inf = inferBodyFromItem(se, "series");
        if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: seUID, level: "series" }; break outer; }
        const inst = await qidoInstances(smUID, seUID, { includefield: "all", limit: 1 });
        if (inst?.length) {
          inf = inferBodyFromItem(inst[0], "instance");
          if (inf) { bodyPart = inf.bodyPart; source = inf.source; chosen = { smStudyUID: smUID, smSeriesUID: seUID, level: "instance" }; break outer; }
        }
      }
    }
    if (!bodyPart) {
      log("SEG_RUN: body part inference failed", { patientID });
      return res.status(404).json({ error: "Could not infer body part from SM metadata", patientID });
    }
    log("SEG_RUN: body part inferred", { bodyPart, source, smStudyUID: chosen.smStudyUID });

    const sct = lookupSCTByBodyPart(bodyPart) || { scheme: "SCT", code: "", meaning: bodyPart, cid: "" };
    const tsKey = TS_LABEL_KEY[bodyPart] || bodyPart;
    log("SEG_RUN: SCT lookup", sct);

    // 2) Download MR study ZIP
    log("SEG_RUN: downloading MR ZIP");
    const url = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies/${encodeURIComponent(mrStudyUID)}?dicomdir=true`;
    const response = await axios.get(url, {
      responseType: "stream",
      headers: arcHeaders("application/zip"),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const work = tmpDir("ts_run");
    log("SEG_RUN: workspace created", work);
    const zipPath = path.join(work, "study.zip");
    await saveStreamToFile(response.data, zipPath);
    log("SEG_RUN: study ZIP saved", zipPath);

    // 3) Unzip DICOM
    const dicomDir = path.join(work, "dicom");
    fs.mkdirSync(dicomDir, { recursive: true });
    await unzipTo(zipPath, dicomDir);
    log("SEG_RUN: DICOM extracted", dicomDir);

    // 4) DICOM -> NIfTI (let dcm2niix choose series)
    const niftiDir = path.join(work, "nifti");
    fs.mkdirSync(niftiDir, { recursive: true });
    await exec(`dcm2niix -z y -o "${niftiDir}" "${dicomDir}"`);
    const inputNii = findFileRecursive(niftiDir, (_p, n) => n.toLowerCase().endsWith(".nii.gz"));
    if (!inputNii) {
      log("SEG_RUN: dcm2niix produced no NIfTI");
      throw new Error("No NIfTI produced by dcm2niix");
    }
    log("SEG_RUN: NIfTI ready", inputNii);

    // 5) TotalSegmentator (MR)
    const tsOut = path.join(work, "ts");
    fs.mkdirSync(tsOut, { recursive: true });
    log("SEG_RUN: running TotalSegmentator", { tsKey });
    await exec(`TotalSegmentator -i "${inputNii}" -o "${tsOut}" --task total_mr --fast`);
    log("SEG_RUN: TotalSegmentator finished");

    // 6) Locate target mask
    const direct = path.join(tsOut, `${tsKey}.nii.gz`);
    let maskPath = fs.existsSync(direct) ? direct : null;
    if (!maskPath && bodyPart === "kidney") {
      const kLeft = path.join(tsOut, `kidney_left.nii.gz`);
      const kRight = path.join(tsOut, `kidney_right.nii.gz`);
      if (fs.existsSync(kLeft) && fs.existsSync(kRight)) maskPath = kLeft; // simple choice; merge if desired
      else if (fs.existsSync(kLeft)) maskPath = kLeft;
      else if (fs.existsSync(kRight)) maskPath = kRight;
    }
    if (!maskPath && bodyPart === "lung") {
      const l = path.join(tsOut, `lung_left.nii.gz`);
      const r = path.join(tsOut, `lung_right.nii.gz`);
      if (fs.existsSync(l)) maskPath = l;
      else if (fs.existsSync(r)) maskPath = r;
    }
    if (!maskPath) {
      const cands = listFilesRecursive(tsOut, (_p, n) => n.toLowerCase().endsWith(".nii.gz") && n.toLowerCase().includes(tsKey));
      maskPath = cands[0] || null;
    }
    if (!maskPath) {
      log("SEG_RUN: mask not found", { bodyPart, tsKey });
      throw new Error(`Target mask for '${bodyPart}' not found in TotalSegmentator output`);
    }
    log("SEG_RUN: mask selected", maskPath);

    // 7) meta.json for dcmqi
    const meta = {
      ContentCreatorName: "AutoTS",
      ClinicalTrialSeriesID: "Session1",
      ClinicalTrialTimePointID: "1",
      SeriesDescription: "Segmentation",
      SeriesNumber: "300",
      InstanceNumber: "1",
      BodyPartExamined: sct.meaning || bodyPart,
      segmentAttributes: [[{
        labelID: 1,
        SegmentDescription: sct.meaning || bodyPart,
        SegmentAlgorithmType: "AUTOMATIC",
        SegmentAlgorithmName: "TotalSegmentator(total_mr)",
        SegmentedPropertyCategoryCodeSequence: {
          CodeValue: "123037004",
          CodingSchemeDesignator: "SCT",
          CodeMeaning: "Anatomical Structure"
        },
        SegmentedPropertyTypeCodeSequence: {
          CodeValue: sct.code || "80891009", // fallback Heart
          CodingSchemeDesignator: "SCT",
          CodeMeaning: sct.meaning || "Heart"
        },
        recommendedDisplayRGBValue: DISPLAY_RGB[bodyPart] || [255, 0, 0]
      }]],
      ContentLabel: "SEGMENTATION",
      ContentDescription: `Segmentation (${bodyPart})`,
      ClinicalTrialCoordinatingCenterName: "dcmqi"
    };
    const metaPath = path.join(work, "meta.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // 8) NIfTI mask -> DICOM SEG (itkimage2segimage)
    const segOutDir = outDir || path.join(work, "seg");
    fs.mkdirSync(segOutDir, { recursive: true });
    const segPath = path.join(segOutDir, `seg_${bodyPart}.dcm`);
    const cmd = [
      `itkimage2segimage`,
      `--inputImageList "${maskPath}"`,
      `--inputDICOMDirectory "${dicomDir}"`,
      `--inputMetadata "${metaPath}"`,
      `--outputDICOM "${segPath}"`
    ].join(" ");
    log("SEG_RUN: converting to SEG");
    await exec(cmd);
    log("SEG_RUN: SEG created", segPath);

    // 9) Upload SEG via STOW-RS (multipart/related; type="application/dicom")
    const stowUrl = `${DCM4CHEE_BASE}/aets/${encodeURIComponent(AET)}/rs/studies`;

    // Create a MIME multipart/related body with a single DICOM part
    const boundary = `dicomboundary-${Date.now()}`;

    // Read the SEG file fully into memory (it's small-ish)
    const dicomBuf = fs.readFileSync(segPath);

    // Part headers for the single DICOM instance
    const partHeader =
      `--${boundary}\r\n` +
      `Content-Type: application/dicom\r\n` +
      `\r\n`; // blank line before binary body

    // Closing boundary
    const closing = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(partHeader, "utf8"),
      dicomBuf,
      Buffer.from(closing, "utf8"),
    ]);

    const stowHeaders = {
      // STOW-RS prefers multipart/related + type="application/dicom"
      "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
      Accept: "application/dicom+json",
      ...(BEARER ? { Authorization: `Bearer ${BEARER}` } : {}),
    };

    log("SEG_RUN: uploading SEG to PACS (multipart/related)", {
      stowUrl,
      segPath,
      boundary,
      bodyLength: body.length,
    });

    const stowResp = await axios.post(stowUrl, body, {
      headers: stowHeaders,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    log("SEG_RUN: STOW response", stowResp.status);

    // Cleanup workspace
    fs.rmSync(work, { recursive: true, force: true });
    log("SEG_RUN: workspace removed");

    const elapsed_ms = Date.now() - t0;
    const payload = {
      status: "ok",
      elapsed_ms,
      mrStudyUID,
      bodyPart,
      sct,
      smStudyUID: chosen.smStudyUID,
      smSeriesUID: chosen.smSeriesUID,
      stow: stowResp.data,
    };
    log("SEG_RUN: success", payload);
    return res.json(payload);
  } catch (err) {
    log("SEG_RUN: error", err?.message || err);
    console.error(err);
    return res.status(500).json({
      error: "TotalSegmentator SEG pipeline failed",
      detail: err?.message || String(err),
    });
  }
});

// ==== start server ====
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  log(`Segment backend listening on :${PORT}`);
  log(`ARC base: ${DCM4CHEE_BASE}  AET: ${AET}`);
  log(`Master JSON: ${MASTER_PATH}`);
});
