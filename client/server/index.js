import 'dotenv/config';
import rateLimit from 'express-rate-limit';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const overloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',

  legacyHeaders: false,
  message: {
    message: 'Too many requests. Please try again shortly.',
  },
});
const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI =
  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nexora';

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/rate-limit-test', overloadLimiter, (req, res) => {
  res.json({
    message: 'Rate limiter is active.',
    limit: 30,
    windowSeconds: 60,
  });
});

const uploadDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (extension !== '.csv') {
      return callback(new Error('Only CSV files are supported.'));
    }

    callback(null, true);
  },
});

const NUMERIC_FIELDS = [
  'voltage', 'current', 'power_load_kw', 'frequency_hz',
  'transformer_temp_c', 'pressure_psi', 'flow_rate_lpm',
  'tank_level_percent', 'vehicle_count', 'sensor_latency_ms',
  'available_beds', 'resource_count', 'emergency_units_available',
];

const VALID_RANGES = {
  voltage: [0, 300],
  current: [0, 500],
  power_load_kw: [0, 100000],
  frequency_hz: [45, 55],
  transformer_temp_c: [-20, 200],
  pressure_psi: [0, 300],
  flow_rate_lpm: [0, 100000],
  tank_level_percent: [0, 100],
  vehicle_count: [0, 100000],
  sensor_latency_ms: [0, 60000],
  available_beds: [0, 10000],
  resource_count: [0, 100000],
  emergency_units_available: [0, 1000],
};

function healCsvRows(rows) {
  const report = {
    totalRecords: rows.length,
    missingValues: 0,
    invalidValues: 0,
    duplicateRecords: 0,
    malformedRows: 0,
    repairedRecords: 0,
    repairedValues: 0,
    needsReview: 0,
    removedRecords: 0,
    outliersDetected: 0,
    outliersFlagged: 0,
  };

  const numericFields = NUMERIC_FIELDS;
  const validRanges = VALID_RANGES;

  const fieldNames = Object.keys(rows[0] || {});
  const numericKeys = fieldNames.filter((key) =>
    numericFields.includes(key.toLowerCase())
  );

  // Calculate medians using valid values from the original dataset.
  const medians = {};

  for (const key of numericKeys) {
    const field = key.toLowerCase();
    const [min, max] = validRanges[field];

    const values = rows
      .map((row) => Number(String(row[key] ?? '').trim()))
      .filter((value) =>
        Number.isFinite(value) && value >= min && value <= max
      )
      .sort((a, b) => a - b);

    if (values.length > 0) {
      const middle = Math.floor(values.length / 2);
      medians[key] = values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2;
    }
  }
  
  // Detect statistical outliers using the IQR method.
  // Outliers are flagged for review, not automatically overwritten.
  const outlierBounds = {};

  for (const key of numericKeys) {
    const field = key.toLowerCase();
    const [min, max] = validRanges[field];

    const values = rows
      .map((row) => {
        const raw = String(row[key] ?? '').trim();
        return raw === '' ? NaN : Number(raw);
      })
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value >= min &&
          value <= max
      )
      .sort((a, b) => a - b);

    if (values.length < 4) continue;

    const percentile = (arr, p) => {
      const index = (arr.length - 1) * p;
      const lower = Math.floor(index);
      const upper = Math.ceil(index);

      if (lower === upper) return arr[lower];

      return (
        arr[lower] * (upper - index) +
        arr[upper] * (index - lower)
      );
    };

    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const iqr = q3 - q1;

    // If all values are identical, there is no useful IQR signal.
    if (iqr === 0) continue;

    outlierBounds[key] = {
      lower: Math.max(min, q1 - 1.5 * iqr),
      upper: Math.min(max, q3 + 1.5 * iqr),
    };
  }

  const seen = new Set();
  const cleanedRows = [];
  const changes = [];
  const MAX_CHANGES = 200;

  for (const original of rows) {
    const row = { ...original };
    let changed = false;
    let needsReview = false;
    const recordId = original[fieldNames[0]] ?? '';
    const fingerprint = JSON.stringify(
      Object.keys(row).sort().map((key) => [key, row[key]])
    );

    if (seen.has(fingerprint)) {
      report.duplicateRecords++;
      report.removedRecords++;
      if (changes.length < MAX_CHANGES) {
        changes.push({
          recordId, column: '(row)', before: 'duplicate', after: 'removed',
          action: 'REMOVED', reason: 'Exact duplicate record',
        });
      }
      continue;
    }

    seen.add(fingerprint);

    for (const key of numericKeys) {
      const field = key.toLowerCase();
      const raw = String(row[key] ?? '').trim();
      const [min, max] = validRanges[field];

      const missing = raw === '';
      const value = Number(raw);
      const invalid =
        !missing &&
        (!Number.isFinite(value) || value < min || value > max);

      if (missing) report.missingValues++;
      if (invalid) report.invalidValues++;
      
      const bounds = outlierBounds[key];

      const isOutlier =
        !missing &&
        !invalid &&
        bounds &&
        (value < bounds.lower || value > bounds.upper);

      if (isOutlier) {
        report.outliersDetected++;
        report.outliersFlagged++;
        needsReview = true;
        if (changes.length < MAX_CHANGES) {
          changes.push({
            recordId, column: key, before: raw, after: raw,
            action: 'FLAGGED', reason: 'Statistical outlier (IQR); kept for review',
          });
        }
      }
      if (missing || invalid) {
        if (medians[key] !== undefined) {
          row[key] = String(medians[key]);
          report.repairedValues++;
          changed = true;
          if (changes.length < MAX_CHANGES) {
            changes.push({
              recordId, column: key, before: raw, after: row[key],
              action: 'REPAIRED',
              reason: missing
                ? 'Missing value replaced with column median'
                : 'Invalid or out-of-range value replaced with column median',
            });
          }
        } else {
          needsReview = true;
          if (changes.length < MAX_CHANGES) {
            changes.push({
              recordId, column: key, before: raw, after: raw,
              action: 'FLAGGED', reason: 'No valid values to compute a median',
            });
          }
        }
      }
    }

    for (const key of Object.keys(row)) {
      if (numericKeys.includes(key)) continue;

      if (row[key] == null || String(row[key]).trim() === '') {
        report.missingValues++;
        needsReview = true;
      }
    }

    if (changed) report.repairedRecords++;

    if (needsReview) report.needsReview++;

    cleanedRows.push(row);
  }

  return {
    rows: cleanedRows,
    changes,
    report: {
      ...report,
      outputRecords: cleanedRows.length,
    },
  };
}
app.post(
  '/api/data-healing/upload',
  upload.single('file'),
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload a CSV file.',
      });
    }

    try {
      const content = fs.readFileSync(req.file.path, 'utf8');

      const rows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: false,
        bom: true,
      });

      if (!rows.length || !Object.keys(rows[0]).length) {
        return res.status(400).json({
          success: false,
          message: 'The CSV file has no usable data rows.',
        });
      }

const result = healCsvRows(rows);
const report = result.report;

const eventStatus =
  report.needsReview > 0
    ? 'NEEDS_REVIEW'
    : report.repairedValues > 0
      ? 'REPAIRED'
      : 'NO_REPAIR_NEEDED';

const eventId = `NX-DH-${randomUUID()}`;

await DataHealingEvent.create({
  eventId,
  eventType: 'CSV_DATA_HEALING',
  status: eventStatus,
  filename: req.file.originalname,
  report,
});
      

      const originalPreview = rows.slice(0, 10).map(row => ({ ...row }));
      const repairedPreview = result.rows.slice(0, 10).map(row => ({ ...row }));
      const outputName = `healed-${randomUUID()}.csv`;
      const outputPath = path.join(uploadDir, outputName);

      fs.writeFileSync(
        outputPath,
        stringify(result.rows, { header: true }),
        'utf8',
      );

      return res.json({
        success: true,
        eventId,
        eventStatus,
        message: 'CSV analysis completed.',
        healingMode: 'Missing and out-of-range numeric values are replaced with the column median. Values that cannot be repaired are flagged for review.',
        report: result.report,
        changes: result.changes,
        downloadUrl: `/api/data-healing/download/${outputName}`,
        preview: {
  original: originalPreview,
  repaired: repairedPreview,
},
      });
    } catch (error) {
      console.error('[NEXORA CSV upload error]', error.message);

      return res.status(400).json({
        success: false,
        message: 'CSV could not be processed. Check its format and headers.',
      });
    } finally {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }
  }
);

app.get('/api/data-healing/download/:filename', (req, res) => {
  const filename = req.params.filename;

  if (!/^healed-[a-f0-9-]+\.csv$/i.test(filename)) {
    return res.status(400).json({
      message: 'Invalid filename.',
    });
  }

  const filePath = path.join(uploadDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      message: 'File not found.',
    });
  }

  return res.download(filePath, filename);
});

const SERVICE_SEED = [
  {
    id: 'powergrid',
    name: 'PowerGrid',
    category: 'Electricity',
    description: 'Electricity distribution (readings streamed from powergrid.csv)',
    status: 'HEALTHY',
    workerRunning: true,
    dependencyAvailable: true,
    recordValid: true,
    queueDepth: 0,
    monitorSignalAvailable: true,
    loadPct: 34,
    latencyMs: 42,
    metricLabel: 'Grid Load',
    metricUnit: '%',
  },
  {
    id: 'aquaflow',
    name: 'AquaFlow',
    category: 'Water Supply',
    description: 'Water and pump services (readings streamed from aquaflow.csv)',
    status: 'HEALTHY',
    workerRunning: true,
    dependencyAvailable: true,
    recordValid: true,
    queueDepth: 0,
    monitorSignalAvailable: true,
    loadPct: 41,
    latencyMs: 55,
    metricLabel: 'Tank Level',
    metricUnit: '%',
  },
  {
    id: 'citylink',
    name: 'CityLink',
    category: 'Communications',
    description: 'Traffic and signal network (readings streamed from citylink.csv)',
    status: 'HEALTHY',
    workerRunning: true,
    dependencyAvailable: true,
    recordValid: true,
    queueDepth: 0,
    monitorSignalAvailable: true,
    loadPct: 27,
    latencyMs: 38,
    metricLabel: 'Traffic Load',
    metricUnit: '%',
  },
  {
    id: 'medicore',
    name: 'MediCore',
    category: 'Hospital Resources',
    description: 'Hospital resources (readings streamed from medicore.csv)',
    status: 'HEALTHY',
    workerRunning: true,
    dependencyAvailable: true,
    recordValid: true,
    queueDepth: 0,
    monitorSignalAvailable: true,
    loadPct: 19,
    latencyMs: 64,
    metricLabel: 'Bed Occupancy',
    metricUnit: '%',
  },
];
const serviceSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, required: true },
    name: String,
    category: String,
    description: String,
    status: {
      type: String,
      enum: ['HEALTHY', 'DEGRADED', 'FAILED'],
      default: 'HEALTHY',
    },
    workerRunning: { type: Boolean, default: true },
    dependencyAvailable: { type: Boolean, default: true },
    recordValid: { type: Boolean, default: true },
    queueDepth: { type: Number, default: 0 },
    monitorSignalAvailable: { type: Boolean, default: true },
    loadPct: { type: Number, default: 25 },
    latencyMs: { type: Number, default: 50 },
    metricLabel: { type: String, default: 'Service Load' },
    metricUnit: { type: String, default: '%' },
    riskScore: { type: Number, default: 0 },
    riskLevel: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH'],
      default: 'LOW',
    },
    riskReasons: { type: [String], default: [] },
    riskUpdatedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

const incidentSchema = new mongoose.Schema(
  {
    incidentId: { type: String, unique: true, required: true },
    serviceId: String,
    serviceName: String,
    type: String,
    status: { type: String, default: 'INJECTED' },
    diagnosis: String,
    recoveryAction: String,
    verification: String,
    injectedAt: Date,
    detectedAt: Date,
    diagnosedAt: Date,
    actionTakenAt: Date,
    recoveredAt: Date,
    failedAt: Date,
    detectionMs: Number,
    recoveryMs: Number,
    totalMs: Number,
    healingEnabled: Boolean,
    notes: String,
  },
  { versionKey: false },
);

const Service = mongoose.model('NexoraService', serviceSchema);
const Incident = mongoose.model('NexoraIncident', incidentSchema);



const dataHealingEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, unique: true, required: true },
    eventType: { type: String, default: 'CSV_DATA_HEALING' },
    status: {
      type: String,
      enum: ['REPAIRED', 'NO_REPAIR_NEEDED', 'NEEDS_REVIEW', 'FAILED'],
      default: 'NO_REPAIR_NEEDED',
    },
    filename: String,
    report: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

const DataHealingEvent = mongoose.model(
  'NexoraDataHealingEvent',
  dataHealingEventSchema
);


const quarantinedRecordSchema = new mongoose.Schema(
  {
    quarantineId: {
      type: String,
      required: true,
      unique: true
    },
    incidentId: {
      type: String,
      required: true
    },
    serviceId: {
      type: String,
      required: true
    },
    source: {
      type: String,
      default: 'SIMULATED_DEMO_FIXTURE'
    },
    originalRecord: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    reason: {
      type: String,
      required: true
    },
    quarantinedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['QUARANTINED', 'REVIEWED'],
      default: 'QUARANTINED'
    }
  },
  { versionKey: false }
);

const QuarantinedRecord = mongoose.model(
  'NexoraQuarantinedRecord',
  quarantinedRecordSchema
);


let healingEnabled = true;
const MONITOR_INTERVAL_MS = 2000;

let monitorState = {
  running: false,
  lastCheckAt: null,
  totalChecks: 0,
  healthyServices: 0,
  degradedServices: 0,
  failedServices: 0,
};

let dbReady = false;
const activeTests = new Set();

const FAILURE_TYPES = [
  {
    type: 'PROCESS_CRASH',
    label: 'Process Crash',
    description: 'A simulated worker stops; the supervisor restarts it.',
    autoRecoverable: true,
  },
  {
    type: 'DEPENDENCY_TIMEOUT',
    label: 'Dependency Timeout',
    description: 'A simulated dependency times out and is restored.',
    autoRecoverable: true,
  },
  {
    type: 'INVALID_RECORD',
    label: 'Invalid Record',
    description:
      'An invalid demo record is quarantined and a safe fixture is restored.',
    autoRecoverable: true,
  },
  {
    type: 'REQUEST_OVERLOAD',
    label: 'Request Overload',
    description:
      'A simulated request burst is rate-limited and the queue is drained.',
    autoRecoverable: true,
  },
  {
    type: 'UNOBSERVABLE_FAULT',
    label: 'Detection Blind Spot',
    description: 'The normal health signal becomes unavailable.',
    autoRecoverable: false,
  },
];


function publicService(service) {
  return {
    id: service.id,
    name: service.name,
    category: service.category,
    description: service.description,
    status: service.status,
    workerRunning: service.workerRunning,
    dependencyAvailable: service.dependencyAvailable,
    recordValid: service.recordValid,
    queueDepth: service.queueDepth,
    monitorSignalAvailable: service.monitorSignalAvailable,
    loadPct: service.loadPct ?? 0,
    latencyMs: service.latencyMs ?? 0,
    metricLabel: service.metricLabel ?? 'Service Load',
    metricUnit: service.metricUnit ?? '%',

    riskScore: service.riskScore ?? 0,
    riskLevel: service.riskLevel ?? 'LOW',
    riskReasons: service.riskReasons ?? [],
    riskUpdatedAt: service.riskUpdatedAt ?? null,

    updatedAt: service.updatedAt,
  };
}


function timeMs(start, end) {
  if (!start || !end) return null;

  return Math.max(
    0,
    new Date(end).getTime() - new Date(start).getTime(),
  );
}

async function saveIncident(incident) {
  return Incident.findOneAndUpdate(
    { incidentId: incident.incidentId },
    { $set: incident },
    {
      upsert: true,
      returnDocument: 'after',
      setDefaultsOnInsert: true,
    },
  );
}

async function updateService(id, patch) {
  return Service.findOneAndUpdate(
    { id },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

async function getService(id) {
  return Service.findOne({ id });
}

const DEPENDENTS = {
  powergrid: ['aquaflow'],
  citylink: ['medicore'],
};

async function markDependentsDegraded(serviceId) {
  const dependentIds = DEPENDENTS[serviceId] || [];

  for (const dependentId of dependentIds) {
    await updateService(dependentId, {
      dependencyAvailable: false,
      status: 'DEGRADED',
    });
  }
}

async function restoreDependents(serviceId) {
  const dependentIds = DEPENDENTS[serviceId] || [];

  for (const dependentId of dependentIds) {
    const service = await getService(dependentId);
    if (!service) continue;

    const canBeHealthy =
      service.workerRunning &&
      service.recordValid &&
      service.queueDepth <= 5 &&
      service.monitorSignalAvailable;

    await updateService(dependentId, {
      dependencyAvailable: true,
      status: canBeHealthy ? 'HEALTHY' : 'DEGRADED',
    });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryDependencyWithBackoff(serviceId, maxAttempts = 4) {
  const baseDelayMs = 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const service = await getService(serviceId);

    if (service?.dependencyAvailable) {
      console.log(
        `[NEXORA] Dependency available after ${attempt} attempt(s).`,
      );

      return {
        success: true,
        attempts: attempt,
      };
    }

    if (attempt < maxAttempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);

      console.log(
        `[NEXORA] Dependency retry ${attempt}/${maxAttempts}; waiting ${delay}ms.`,
      );

      await wait(delay);
    }
  }

  await updateService(serviceId, {
    dependencyAvailable: true,
  });

  const recoveredService = await getService(serviceId);

  return {
    success: Boolean(recoveredService?.dependencyAvailable),
    attempts: maxAttempts,
  };
}
const DATASET_DIR = path.join(__dirname, '..', 'datasets');
const ROWS_PER_CYCLE = 10;
const HISTORY_POINTS = 40;
const ZONE_COUNT = 10;
const ANOMALY_TTL_MS = 15000;

const TELEMETRY_SOURCES = {
  powergrid: { file: 'powergrid.csv', loadField: 'power_load_kw', loadMax: 12 },
  aquaflow: { file: 'aquaflow.csv', loadField: 'tank_level_percent', loadMax: 100 },
  citylink: { file: 'citylink.csv', loadField: 'vehicle_count', loadMax: 200 },
  medicore: {
    file: 'medicore.csv',
    loadField: 'available_beds',
    loadMax: 100,
    invert: true,
  },
};

const telemetry = {};
const recentAnomalies = [];

function loadTelemetry() {
  for (const [id, source] of Object.entries(TELEMETRY_SOURCES)) {
    try {
      const content = fs.readFileSync(
        path.join(DATASET_DIR, source.file),
        'utf8',
      );

      const rows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      });

      telemetry[id] = {
        source,
        rows,
        cursor: 0,
        history: [],
        loadPct: null,
        anomalyCount: 0,
        zones: {},
      };

      console.log(`[NEXORA] Telemetry loaded: ${source.file} (${rows.length} rows)`);
    } catch (error) {
      console.warn(
        `[NEXORA] Telemetry dataset not loaded for ${id}: ${error.message}`,
      );
    }
  }
}

function zoneNumber(row) {
  const match = /(\d+)/.exec(String(row.area ?? ''));
  return match ? Number(match[1]) : null;
}
function readingProblem(row) {
  for (const [field, [min, max]] of Object.entries(VALID_RANGES)) {
    if (!(field in row)) continue;

    const raw = String(row[field] ?? '').trim();

    if (raw === '') return `${field} is missing`;

    const value = Number(raw);

    if (!Number.isFinite(value)) return `${field} is not a number (${raw})`;
    if (value < min || value > max) return `${field} out of range (${raw})`;
  }

  return null;
}

function advanceTelemetry() {
  const now = Date.now();

  for (const [serviceId, state] of Object.entries(telemetry)) {
    if (!state.rows.length) continue;

    const loads = [];

    for (let i = 0; i < ROWS_PER_CYCLE; i++) {
      const row = state.rows[state.cursor % state.rows.length];
      state.cursor++;

      const zone = zoneNumber(row);
      const problem = readingProblem(row);

      if (problem && zone) {
        state.zones[zone] = {
          until: now + ANOMALY_TTL_MS,
          reason: problem,
          recordId: row.record_id,
        };

        state.anomalyCount++;

        recentAnomalies.unshift({
          at: new Date(now).toISOString(),
          serviceId,
          zone,
          recordId: row.record_id,
          reason: problem,
        });

        if (recentAnomalies.length > 30) recentAnomalies.pop();
      }

      const value = Number(String(row[state.source.loadField] ?? '').trim());

      if (
        Number.isFinite(value) &&
        value >= 0 &&
        value <= state.source.loadMax
      ) {
        loads.push(value);
      }
    }

    if (loads.length) {
      const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
      const pct = (mean / state.source.loadMax) * 100;

      state.loadPct = Math.max(
        1,
        Math.min(99, Math.round(state.source.invert ? 100 - pct : pct)),
      );

      state.history.push(state.loadPct);

      if (state.history.length > HISTORY_POINTS) state.history.shift();
    }
  }
}

function buildZones(services) {
  const now = Date.now();
  const zones = [];

  for (let zone = 1; zone <= ZONE_COUNT; zone++) {
    const cells = {};

    for (const service of services) {
      let state = 'HEALTHY';
      let reason = null;

      if (service.status === 'FAILED') {
        state = 'FAILED';
        reason = 'Service failed';
      } else if (service.status === 'DEGRADED') {
        state = 'DEGRADED';
        reason = 'Service degraded';
      } else {
        const flagged = telemetry[service.id]?.zones[zone];

        if (flagged && flagged.until > now) {
          state = 'ANOMALY';
          reason = `${flagged.recordId}: ${flagged.reason}`;
        }
      }

      cells[service.id] = { state, reason };
    }

    const states = Object.values(cells).map((cell) => cell.state);

    const overall = states.includes('FAILED')
      ? 'FAILED'
      : states.includes('DEGRADED')
        ? 'DEGRADED'
        : states.includes('ANOMALY')
          ? 'ANOMALY'
          : 'HEALTHY';

    zones.push({ zone, name: `Zone-${zone}`, overall, cells });
  }

  return zones;
}

const DIAGNOSIS = {
  PROCESS_CRASH: 'Worker health check failed: worker is not running.',
  DEPENDENCY_TIMEOUT:
    'Dependency probe failed; the simulated dependency is unavailable.',
  INVALID_RECORD: 'Data validation failed; the active demo record is invalid.',
  REQUEST_OVERLOAD: 'Queue depth crossed the safe threshold.',
};

const RECOVERY_ACTION = {
  PROCESS_CRASH: 'Supervisor restarted the simulated worker.',
  DEPENDENCY_TIMEOUT:
    'Retry with exponential backoff; simulated dependency restored.',
  INVALID_RECORD: 'Invalid record quarantined; safe fixture restored.',
  REQUEST_OVERLOAD: 'Simulated request queue drained.',
};

function faultTypeOf(service) {
  if (!service.workerRunning) return 'PROCESS_CRASH';
  if (!service.recordValid) return 'INVALID_RECORD';
  if (service.queueDepth > 5) return 'REQUEST_OVERLOAD';
  return 'DEPENDENCY_TIMEOUT';
}

function isFullyHealthy(service) {
  return Boolean(
    service &&
      service.workerRunning &&
      service.dependencyAvailable &&
      service.recordValid &&
      service.queueDepth <= 5 &&
      service.monitorSignalAvailable,
  );
}

async function resolveBlindSpot(service) {
  const open = await Incident.findOne({
    serviceId: service.id,
    status: 'INJECTED',
    type: 'UNOBSERVABLE_FAULT',
  }).sort({ injectedAt: -1 });

  if (!open) return;

  const failedAt = new Date();

  await saveIncident({
    incidentId: open.incidentId,
    status: 'DETECTION_FAILED',
    diagnosis:
      'The health monitor could not read a health signal. The fault was not detected by the monitor.',
    recoveryAction:
      'No automatic recovery was triggered because diagnosis was unavailable.',
    verification: 'NOT_VERIFIED',
    failedAt,
    totalMs: timeMs(open.injectedAt, failedAt),
    notes:
      'Known monitoring blind spot; this run is not counted as a successful detection or recovery.',
  });
}

async function handleFault(service, services) {
  const detectedAt = new Date();

  const open = await Incident.findOne({
    serviceId: service.id,
    status: 'INJECTED',
  }).sort({ injectedAt: -1 });

  if (!healingEnabled) {
    if (open) {
      await saveIncident({
        incidentId: open.incidentId,
        status: 'FAILED',
        diagnosis: DIAGNOSIS[faultTypeOf(service)],
        recoveryAction: 'Healing is OFF; no automatic recovery attempted.',
        verification: 'NOT_RUN — healing disabled',
        detectedAt,
        diagnosedAt: new Date(),
        detectionMs: timeMs(open.injectedAt, detectedAt),
        failedAt: new Date(),
        notes:
          'The fault was detected by the health monitor, but automatic healing was disabled.',
      });
    }

    return;
  }
  const upstreamIds = Object.keys(DEPENDENTS).filter((id) =>
    DEPENDENTS[id].includes(service.id),
  );

  const upstreamUnavailable = upstreamIds.some((id) => {
    const upstream = services.find((item) => item.id === id);

    return (
      upstream &&
      (!upstream.workerRunning ||
        !upstream.dependencyAvailable ||
        !upstream.monitorSignalAvailable)
    );
  });

  if (upstreamUnavailable) return;

  const type = faultTypeOf(service);
  const injectedAt = open?.injectedAt ?? detectedAt;

  const incidentId =
    open?.incidentId ??
    `NX-AUTO-${Date.now()}-` +
      Math.random().toString(36).slice(2, 6).toUpperCase();

  const incident = {
    incidentId,
    serviceId: service.id,
    serviceName: service.name,
    type,
    status: 'RECOVERING',
    diagnosis: DIAGNOSIS[type],
    recoveryAction: RECOVERY_ACTION[type],
    verification: 'PENDING',
    injectedAt,
    detectedAt,
    diagnosedAt: new Date(),
    actionTakenAt: new Date(),
    recoveredAt: null,
    failedAt: null,
    detectionMs: timeMs(injectedAt, detectedAt),
    recoveryMs: null,
    totalMs: null,
    healingEnabled: true,
    notes: open
      ? 'Fault injected from Chaos Lab; detected and healed by the background monitor.'
      : 'Detected by the background monitor (injection time unknown).',
  };

  activeTests.add(service.id);

  try {
    await saveIncident(incident);

    const patch = {};

    if (!service.workerRunning) patch.workerRunning = true;
    if (!service.recordValid) patch.recordValid = true;
    if (service.queueDepth > 5) patch.queueDepth = 0;

    if (!service.dependencyAvailable) {
      const retry = await retryDependencyWithBackoff(service.id);

      if (!retry.success) {
        incident.status = 'FAILED';
        incident.failedAt = new Date();
        incident.verification =
          'FAILED — dependency remained unavailable after retries.';
        incident.notes = `Dependency retry exhausted after ${retry.attempts} attempts.`;

        await saveIncident(incident);
        return;
      }

      patch.dependencyAvailable = true;
    }

    if (!service.recordValid) {
      const quarantineId = randomUUID();

      await QuarantinedRecord.create({
        quarantineId,
        incidentId,
        serviceId: service.id,
        source: 'SIMULATED_DEMO_FIXTURE',
        originalRecord: {
          recordId: `demo-${incidentId}`,
          serviceId: service.id,
          valid: false,
          sampleValue: 'INVALID_DEMO_VALUE',
        },
        reason: 'Invalid demo record isolated during self-healing recovery.',
        status: 'QUARANTINED',
      });

      incident.recoveryAction = `Invalid demo record quarantined (${quarantineId}); safe fixture restored.`;
    }

    await updateService(service.id, patch);

    // Verify immediately: re-read the service and run the same health checks.
    const check = await getService(service.id);

    if (isFullyHealthy(check)) {
      await updateService(service.id, { status: 'HEALTHY' });
      await restoreDependents(service.id);

      incident.status = 'RECOVERED';
      incident.recoveredAt = new Date();
      incident.verification =
        'PASSED — post-recovery health and data checks succeeded.';
      incident.recoveryMs = timeMs(incident.detectedAt, incident.recoveredAt);
      incident.totalMs = timeMs(injectedAt, incident.recoveredAt);
    } else {
      incident.status = 'FAILED';
      incident.failedAt = new Date();
      incident.verification = 'FAILED — post-recovery health check did not pass.';
    }

    await saveIncident(incident);
  } finally {
    activeTests.delete(service.id);
  }
}

let monitorBusy = false;

async function runHealthMonitor() {
  if (!dbReady || mongoose.connection.readyState !== 1) return;

  try {
    advanceTelemetry();

    const services = await Service.find().lean();

    let healthy = 0;
    let degraded = 0;
    let failed = 0;

    for (const service of services) {
      
      const loadPct =
        telemetry[service.id]?.loadPct ?? (Number(service.loadPct) || 25);

      const latencyMs = Math.max(
        10,
        Math.min(
          500,
          (Number(service.latencyMs) || 50) +
            Math.round((Math.random() - 0.5) * 14),
        ),
      );

      await updateService(service.id, { loadPct, latencyMs });

      if (!service.monitorSignalAvailable) {
        await resolveBlindSpot(service);
        failed++;
        continue;
      }

      const checksPass =
        service.workerRunning &&
        service.dependencyAvailable &&
        service.recordValid &&
        service.queueDepth <= 5;

      const nextStatus = !service.workerRunning
        ? 'FAILED'
        : checksPass
          ? 'HEALTHY'
          : 'DEGRADED';

      if (service.status !== nextStatus) {
        await updateService(service.id, { status: nextStatus });
      }

      if (!checksPass && !activeTests.has(service.id)) {
        await handleFault(service, services);
      }

      const refreshed = await getService(service.id);
      const finalStatus = refreshed?.status || nextStatus;

      if (finalStatus === 'HEALTHY') healthy++;
      else if (finalStatus === 'DEGRADED') degraded++;
      else failed++;
    }

    monitorState = {
      running: true,
      lastCheckAt: new Date().toISOString(),
      totalChecks: monitorState.totalChecks + 1,
      healthyServices: healthy,
      degradedServices: degraded,
      failedServices: failed,
    };
  } catch (error) {
    console.error('[NEXORA monitor error]', error.message);
  }
}

setInterval(() => {
  if (monitorBusy) return;

  monitorBusy = true;

  runHealthMonitor()
    .catch((error) => {
      console.error('[NEXORA monitor error]', error.message);
    })
    .finally(() => {
      monitorBusy = false;
    });
}, MONITOR_INTERVAL_MS);

app.get('/api/monitor', (_req, res) => {
  res.json({
    ...monitorState,
    intervalMs: MONITOR_INTERVAL_MS,
  });
});

app.get('/api/telemetry', async (_req, res, next) => {
  try {
    const services = await Service.find().sort({ id: 1 }).lean();

    res.json({
      source: 'Rows streamed from client/datasets/*.csv (10 rows per monitor cycle)',
      zones: buildZones(services),
      series: Object.fromEntries(
        Object.entries(telemetry).map(([id, state]) => [
          id,
          { history: state.history, anomalyCount: state.anomalyCount },
        ]),
      ),
      recentAnomalies,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'OK',
    message: 'NEXORA backend is running',
    database:
      dbReady && mongoose.connection.readyState === 1
        ? 'CONNECTED'
        : 'DISCONNECTED',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/failure-types', (_req, res) => {
  res.json({ failureTypes: FAILURE_TYPES });
});

app.get('/api/services', async (_req, res, next) => {
  try {
    const services = await Service.find().sort({ id: 1 }).lean();

    res.json({
      services: services.map(publicService),
      healingEnabled,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/risk-scores', async (_req, res, next) => {
  try {
    const services = await Service.find().sort({ id: 1 }).lean();

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results = [];

    for (const service of services) {
      const recentIncidents = await Incident.countDocuments({
        serviceId: service.id,
        injectedAt: { $gte: since },
      });

      let score = 0;
      const reasons = [];

      if (!service.workerRunning) {
        score += 30;
        reasons.push('Service worker is not running');
      }

      if (!service.dependencyAvailable) {
        score += 20;
        reasons.push('A dependency is unavailable');
      }

      if (!service.recordValid) {
        score += 20;
        reasons.push('Invalid data record detected');
      }

      if (!service.monitorSignalAvailable) {
        score += 25;
        reasons.push('Monitoring signal is unavailable');
      }

      if ((service.latencyMs ?? 0) > 150) {
        score += 15;
        reasons.push('Response latency is high');
      }

      if ((service.loadPct ?? 0) > 75) {
        score += 15;
        reasons.push('Service load is high');
      }

      if ((service.queueDepth ?? 0) > 5) {
        score += 15;
        reasons.push('Request queue exceeds safe threshold');
      }

      if (recentIncidents >= 3) {
        score += 20;
        reasons.push('Three or more incidents in the last 24 hours');
      } else if (recentIncidents > 0) {
        score += 10;
        reasons.push('Recent incident history detected');
      }

      if (service.status === 'DEGRADED') {
        score += 10;
        reasons.push('Service is degraded');
      }

      if (service.status === 'FAILED') {
        score += 20;
        reasons.push('Service has failed');
      }

      score = Math.min(100, score);

      const riskLevel =
        score >= 60 ? 'HIGH' :
        score >= 30 ? 'MEDIUM' :
        'LOW';

      if (reasons.length === 0) {
        reasons.push('No current risk indicators detected');
      }

      const riskUpdatedAt = new Date();

      await Service.updateOne(
        { id: service.id },
        {
          $set: {
            riskScore: score,
            riskLevel,
            riskReasons: reasons,
            riskUpdatedAt,
          },
        },
      );

      results.push({
        id: service.id,
        name: service.name,
        riskScore: score,
        riskLevel,
        riskReasons: reasons,
        riskUpdatedAt,
        recentIncidents,
      });
    }

    return res.json({
      success: true,
      method: 'Rule-based risk scoring',
      description:
        'Risk scores are estimates based on simulated service health, load, latency, queue depth, and incident history.',
      services: results,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/incidents', async (_req, res, next) => {
  try {
    const incidents = await Incident.find()
      .sort({ injectedAt: -1 })
      .limit(100)
      .lean();

    res.json({ incidents });
  } catch (error) {
    next(error);
  }
});

app.get('/api/metrics', async (_req, res, next) => {
  try {
    const all = await Incident.find().lean();

    const recovered = all.filter(
      (incident) => incident.status === 'RECOVERED',
    );

    const detected = all.filter(
      (incident) => Boolean(incident.detectedAt),
    );

    const failed = all.filter((incident) =>
      ['FAILED', 'DETECTION_FAILED'].includes(incident.status),
    );

    const totalTimes = recovered
      .map((incident) => incident.totalMs)
      .filter(Number.isFinite);

    const recoveryTimes = recovered
      .map((incident) => incident.recoveryMs)
      .filter(Number.isFinite);

    const average = (values) =>
      values.length
        ? Math.round(
            values.reduce((sum, value) => sum + value, 0) /
              values.length,
          )
        : null;


        const detectionRate = all.length
  ? Math.round((detected.length / all.length) * 100)
  : 0;
    res.json({
      totalTests: all.length,
      detectedCount: detected.length,
      recoveredCount: recovered.length,
      failedCount: failed.length,
      detectionRate: all.length
        ? Math.round((detected.length / all.length) * 100)
        : 0,
      recoveryRate: all.length
        ? Math.round((recovered.length / all.length) * 100)
        : 0,
      averageTotalRecoveryMs: average(totalTimes),
      averageRecoveryMs: average(recoveryTimes),
      healingEnabled,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/healing', (_req, res) => {
  res.json({ healingEnabled });
});

app.post('/api/healing', (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({
      message: 'Send enabled as true or false.',
    });
  }

  healingEnabled = req.body.enabled;

  return res.json({
    healingEnabled,
    message: `Automatic healing ${
      healingEnabled ? 'enabled' : 'disabled'
    }.`,
  });
});


app.get('/api/data-healing/events', async (_req, res, next) => {
  try {
    const events = await DataHealingEvent.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ events });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/failures/:serviceId',
  (req, res, next) => {
    if (
      String(req.body?.type || 'PROCESS_CRASH').toUpperCase() ===
      'REQUEST_OVERLOAD'
    ) {
      return overloadLimiter(req, res, next);
    }

    next();
  },
  async (req, res, next) => {
    const serviceId = String(req.params.serviceId || '').toLowerCase();

    try {
      const type = String(
        req.body?.type || 'PROCESS_CRASH',
      ).toUpperCase();

      if (!FAILURE_TYPES.some((failure) => failure.type === type)) {
        return res.status(400).json({
          message: 'Unknown failure type.',
        });
      }

      const service = await getService(serviceId);

      if (!service) {
        return res.status(404).json({
          message: 'Service not found.',
        });
      }

      if (activeTests.has(serviceId)) {
        return res.status(409).json({
          message:
            'A recovery is already running for this service. Wait for it to finish.',
        });
      }

      const stillOpen = await Incident.findOne({
        serviceId,
        status: { $in: ['INJECTED', 'RECOVERING'] },
        injectedAt: { $gte: new Date(Date.now() - 60 * 1000) },
      });

      if (stillOpen) {
        return res.status(409).json({
          message:
            'An incident for this service is still being handled. Wait for the monitor to finish.',
        });
      }

      const injectedAt = new Date();
      const incidentId =
        `NX-${Date.now()}-` +
        Math.random().toString(36).slice(2, 7).toUpperCase();

      await saveIncident({
        incidentId,
        serviceId,
        serviceName: service.name,
        type,
        status: 'INJECTED',
        diagnosis: 'Fault injected; waiting for the health monitor to detect it.',
        recoveryAction: 'Pending automated diagnosis.',
        verification: 'PENDING',
        injectedAt,
        detectedAt: null,
        recoveredAt: null,
        failedAt: null,
        detectionMs: null,
        recoveryMs: null,
        totalMs: null,
        healingEnabled,
        notes: '',
      });

      const faultPatch = {
        PROCESS_CRASH: { workerRunning: false, status: 'FAILED' },
        DEPENDENCY_TIMEOUT: { dependencyAvailable: false, status: 'DEGRADED' },
        INVALID_RECORD: { recordValid: false, status: 'DEGRADED' },
        REQUEST_OVERLOAD: { queueDepth: 100, status: 'DEGRADED' },
        UNOBSERVABLE_FAULT: { monitorSignalAvailable: false, status: 'FAILED' },
      }[type];

      await updateService(serviceId, faultPatch);
      await markDependentsDegraded(serviceId);

      return res.status(202).json({
        message: `Fault injected into ${service.name}. The health monitor checks every ${MONITOR_INTERVAL_MS / 1000} s; watch Incident History for the result.`,
        incidentId,
        status: 'INJECTED',
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post('/api/recovery/:serviceId', async (req, res, next) => {
  try {
    const service = await getService(
      String(req.params.serviceId || '').toLowerCase(),
    );

    if (!service) {
      return res.status(404).json({
        message: 'Service not found.',
      });
    }

    if (activeTests.has(service.id)) {
      return res.status(409).json({
        message: 'Wait for the current test to finish.',
      });
    }

    await updateService(service.id, {
      workerRunning: true,
      dependencyAvailable: true,
      recordValid: true,
      queueDepth: 0,
      monitorSignalAvailable: true,
      status: 'HEALTHY',
    });

    const check = await getService(service.id);

    const verified = Boolean(
      check &&
        check.workerRunning &&
        check.dependencyAvailable &&
        check.recordValid &&
        check.queueDepth === 0 &&
        check.monitorSignalAvailable,
    );

    if (!verified) {
      return res.status(500).json({
        message: 'Manual recovery verification failed.',
      });
    }

    await restoreDependents(service.id);

    return res.json({
      message: 'Demo reset completed and health check passed.',
      verified,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reset', async (_req, res, next) => {
  try {
    if (activeTests.size > 0) {
      return res.status(409).json({
        message: 'Wait for active tests to finish before resetting.',
      });
    }

    for (const seed of SERVICE_SEED) {
      await Service.findOneAndUpdate(
        { id: seed.id },
        { $set: { ...seed, updatedAt: new Date() } },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      );
    }

    await Incident.deleteMany({});

    return res.json({
      message: 'Demo state reset. Incident history cleared.',
      services: SERVICE_SEED.length,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/json', async (_req, res, next) => {
  try {
    const incidents = await Incident.find()
      .sort({ injectedAt: -1 })
      .limit(1000)
      .lean();

    const services = await Service.find()
      .sort({ id: 1 })
      .lean();

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="nexora-report.json"',
    );
    res.setHeader('Content-Type', 'application/json');

    return res.json({
      project: 'NEXORA Smart City Systems',
      exportedAt: new Date().toISOString(),
      summary: {
        totalIncidents: incidents.length,
        recovered: incidents.filter(
          (item) => item.status === 'RECOVERED',
        ).length,
        failed: incidents.filter(
          (item) => item.status === 'FAILED',
        ).length,
        detectionFailed: incidents.filter(
          (item) => item.status === 'DETECTION_FAILED',
        ).length,
      },
      services: services.map(publicService),
      incidents,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/csv', async (_req, res, next) => {
  try {
    const incidents = await Incident.find()
      .sort({ injectedAt: -1 })
      .limit(1000)
      .lean();

    const columns = [
      'incidentId',
      'serviceName',
      'type',
      'status',
      'diagnosis',
      'recoveryAction',
      'verification',
      'injectedAt',
      'detectedAt',
      'recoveredAt',
      'detectionMs',
      'recoveryMs',
      'totalMs',
      'healingEnabled',
    ];

    const escapeCSV = (value) => {
      const text = value == null ? '' : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    const rows = incidents.map((incident) =>
      columns
        .map((column) => escapeCSV(incident[column]))
        .join(','),
    );

    const csv = [columns.join(','), ...rows].join('\r\n');

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="nexora-report.csv"',
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');

    return res.send('\uFEFF' + csv);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error('[NEXORA API error]', error);

  if (res.headersSent) return;

  res.status(500).json({
    message:
      'Server error. Check the backend terminal and MongoDB connection.',
  });
});

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    dbReady = true;
    loadTelemetry();
    console.log(`MongoDB connected: ${mongoose.connection.name}`);

    for (const seed of SERVICE_SEED) {
      await Service.findOneAndUpdate(
        { id: seed.id },
        {
          $set: {
            ...seed,
            updatedAt: new Date(),
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      );
    }

    app.listen(PORT, () => {
      console.log(`NEXORA backend listening on port ${PORT}`);
    });
  } catch (error) {
    dbReady = false;

    console.error(
      'Could not connect to MongoDB. Make sure MongoDB is running.',
      error.message,
    );

    process.exitCode = 1;
  }
}

startServer();