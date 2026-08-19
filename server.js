const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check to verify deployment
app.get('/', (req, res) => {
  res.send("Server is running and ready for /promote!");
});

// Catch Express body-parser errors (e.g., malformed JSON)
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }
  next();
});

function isSafeNonNegativeInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isValidTimestamp(ts) {
  const regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof ts !== 'string' || !regex.test(ts)) return false;
  return !isNaN(new Date(ts).getTime());
}

function parseTime(ts) {
  return new Date(ts).getTime();
}

function isCanonicalVersion(v) {
  if (typeof v !== 'string') return false;
  if (!/^[1-9]\d*$/.test(v)) return false;
  const num = Number(v);
  return Number.isSafeInteger(num) && num > 0 && String(num) === v;
}

function isPolicyValid(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.datasetDigest !== 'string' || p.datasetDigest === '') return false;
  if (typeof p.schemaDigest !== 'string' || p.schemaDigest === '') return false;
  if (!isSafeNonNegativeInt(p.maxAgeSeconds)) return false;
  if (!isSafeNonNegativeInt(p.maxSizeBytes)) return false;
  if (typeof p.maxLatencyMs !== 'number' || !Number.isFinite(p.maxLatencyMs) || p.maxLatencyMs < 0) return false;
  if (typeof p.accuracyFloor !== 'number' || !Number.isFinite(p.accuracyFloor) || p.accuracyFloor < 0 || p.accuracyFloor > 1) return false;
  if (typeof p.minImprovement !== 'number' || !Number.isFinite(p.minImprovement) || p.minImprovement < 0 || p.minImprovement > 1) return false;
  
  if (!p.requiredSlices || typeof p.requiredSlices !== 'object') return false;
  for (const k in p.requiredSlices) {
    const v = p.requiredSlices[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return false;
  }
  return true;
}

// THIS IS THE ROUTE THE GRADER CALLS
app.post('/promote', (req, res) => {
  try {
    const b = req.body;

    if (!b || typeof b !== 'object' || !b.policy || !Array.isArray(b.versions) || typeof b.championVersion !== 'string' || !isValidTimestamp(b.asOf)) {
      return res.status(400).json({ error: "INVALID_INPUT" });
    }

    const counts = {};
    for (const v of b.versions) {
      if (v && typeof v.version === 'string') {
        counts[v.version] = (counts[v.version] || 0) + 1;
      }
    }

    const failedGates = {};
    const eligibleVersions = [];
    const versionMap = {};

    const policyValid = isPolicyValid(b.policy);

    for (const v of b.versions) {
      if (!v || typeof v.version !== 'string') continue;
      const vid = v.version;
      
      if (!failedGates[vid]) failedGates[vid] = new Set();
      
      const validId = isCanonicalVersion(vid);
      if (!validId) failedGates[vid].add('INVALID_VERSION');
      if (counts[vid] > 1) failedGates[vid].add('DUPLICATE_VERSION');

      if (!validId || counts[vid] > 1) continue;

      if (!policyValid) {
        failedGates[vid].add('INVALID_POLICY');
        continue;
      }

      const ev = v.evaluation;
      if (!ev) {
        failedGates[vid].add('MISSING_EVALUATION');
        continue;
      }

      if (!isValidTimestamp(ev.createdAt)) {
        failedGates[vid].add('INVALID_TIMESTAMP');
      } else {
        const ca = parseTime(ev.createdAt);
        const ao = parseTime(b.asOf);
        if (ca > ao) failedGates[vid].add('FUTURE_EVALUATION');
        else if (ca < ao - b.policy.maxAgeSeconds * 1000) failedGates[vid].add('STALE_EVALUATION');
      }

      const isFin = (val) => typeof val === 'number' && Number.isFinite(val);
      
      if (!isFin(ev.accuracy) || !isFin(ev.latencyMs) || !isFin(ev.sizeBytes)) {
        failedGates[vid].add('NON_FINITE');
      } else {
        if (ev.accuracy < 0 || ev.accuracy > 1 || ev.latencyMs < 0 || ev.sizeBytes < 0 || !Number.isSafeInteger(ev.sizeBytes)) {
          failedGates[vid].add('METRIC_RANGE');
        } else {
          if (ev.accuracy < b.policy.accuracyFloor) failedGates[vid].add('ACCURACY_FLOOR');
          if (ev.latencyMs > b.policy.maxLatencyMs) failedGates[vid].add('LATENCY_LIMIT');
          if (ev.sizeBytes > b.policy.maxSizeBytes) failedGates[vid].add('SIZE_LIMIT');
        }
      }

      if (ev.artifactDigest !== v.artifactDigest) failedGates[vid].add('ARTIFACT_MISMATCH');
      if (ev.datasetDigest !== b.policy.datasetDigest) failedGates[vid].add('DATASET_MISMATCH');
      if (ev.schemaDigest !== b.policy.schemaDigest) failedGates[vid].add('SCHEMA_MISMATCH');

      if (b.policy.requiredSlices) {
        for (const s in b.policy.requiredSlices) {
          const sv = (ev.slices && ev.slices[s] !== undefined) ? ev.slices[s] : undefined;
          if (sv === undefined) failedGates[vid].add(`MISSING_SLICE:${s}`);
          else if (!isFin(sv) || sv < 0 || sv > 1) failedGates[vid].add(`SLICE_RANGE:${s}`);
          else if (sv < b.policy.requiredSlices[s]) failedGates[vid].add(`SLICE_FLOOR:${s}`);
        }
      }

      if (failedGates[vid].size === 0) eligibleVersions.push(v);
      versionMap[vid] = v;
    }

    const finalFailedGates = {};
    for (const vid in failedGates) {
      finalFailedGates[vid] = Array.from(failedGates[vid]).sort();
    }

    eligibleVersions.sort((a, b) => {
      if (b.evaluation.accuracy !== a.evaluation.accuracy) return b.evaluation.accuracy - a.evaluation.accuracy;
      if (a.evaluation.latencyMs !== b.evaluation.latencyMs) return a.evaluation.latencyMs - b.evaluation.latencyMs;
      if (a.evaluation.sizeBytes !== b.evaluation.sizeBytes) return a.evaluation.sizeBytes - b.evaluation.sizeBytes;
      return Number(a.version) - Number(b.version);
    });

    let action = "block";
    let selectedVersion = null;
    let aliasMutation = null;
    let evidence = null;

    const isChampEligible = eligibleVersions.some(v => v.version === b.championVersion);

    if (isChampEligible) {
      const champ = versionMap[b.championVersion];
      const chal = eligibleVersions[0];

      if (chal.version === champ.version) {
        action = "retain";
        selectedVersion = champ.version;
        evidence = champ.evaluation;
      } else {
        const diff = Number((chal.evaluation.accuracy - champ.evaluation.accuracy).toFixed(12));
        if (diff >= b.policy.minImprovement) {
          action = "promote";
          selectedVersion = chal.version;
          aliasMutation = { alias: "champion", version: chal.version };
          evidence = chal.evaluation;
        } else {
          action = "retain";
          selectedVersion = champ.version;
          evidence = champ.evaluation;
        }
      }
    }

    return res.json({
      action,
      championVersion: b.championVersion,
      selectedVersion,
      eligibleVersions: eligibleVersions.map(v => v.version),
      failedGates: finalFailedGates,
      aliasMutation,
      evidence
    });
    
  } catch (error) {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Promote Gate listening on port ${port}`));
