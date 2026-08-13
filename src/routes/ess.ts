/**
 * ESS qualification + map layers.
 *   POST /api/ess/qualify        address|coords → compensation tier + ITC stack
 *   GET  /api/ess/qualify?address=...           (convenience)
 *   GET  /api/ess/layers/:name   raw GeoJSON for the dashboard map overlays
 *   GET  /api/ess/status         which datasets are loaded
 * Public (the dashboard consumes it; datasets are public program data).
 */
import { Router } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse, errorResponse } from '../utils/response';
import { qualifyEss } from '../services/ess.service';
import { getLayer, essDataStatus } from '../services/essGeo.service';
import { mfahGeoJSON, mfahStatus } from '../services/mfah.service';
import { listContractors, getContractor } from '../services/contractors.service';
import { ESS_LAYERS, type EssLayerName } from '../config/ess';

const router = Router();

async function handleQualify(body: { address?: string; lat?: number; lng?: number; town?: string }, res: import('express').Response) {
  const result = await qualifyEss({
    address: typeof body.address === 'string' ? body.address : undefined,
    lat: body.lat != null ? Number(body.lat) : undefined,
    lng: body.lng != null ? Number(body.lng) : undefined,
    town: typeof body.town === 'string' ? body.town : undefined,
  });
  res.json(successResponse(result));
}

router.post('/qualify', async (req, res, next) => {
  try {
    await handleQualify(req.body ?? {}, res);
  } catch (err) {
    next(err);
  }
});

router.get('/qualify', async (req, res, next) => {
  try {
    await handleQualify(req.query as never, res);
  } catch (err) {
    next(err);
  }
});

// ESS program contractor directory.
router.get('/contractors', (_req, res) => {
  res.json(successResponse(listContractors()));
});

router.get('/contractors/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('INVALID_ID', 'Invalid contractor id'));
  }
  const c = getContractor(id);
  if (!c) {
    return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('CONTRACTOR_NOT_FOUND', 'Contractor not found'));
  }
  res.json(successResponse(c));
});

router.get('/status', async (_req, res, next) => {
  try {
    const base = essDataStatus();
    const m = await mfahStatus();
    base.layers.push({
      name: 'mfah-properties',
      label: 'Affordable-housing properties (MFAH)',
      loaded: m.count > 0,
      features: m.geocoded, // only geocoded points render on the map
    });
    res.json(successResponse(base));
  } catch (err) {
    next(err);
  }
});

router.get('/layers/:name', async (req, res, next) => {
  try {
    if (req.params.name === 'mfah-properties') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json(await mfahGeoJSON());
    }
    const name = req.params.name as EssLayerName;
    if (!(name in ESS_LAYERS)) {
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('LAYER_NOT_FOUND', 'Unknown layer'));
    }
    const fc = getLayer(name);
    if (!fc) {
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('LAYER_NOT_LOADED', `Layer "${name}" data not uploaded yet`));
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(fc); // raw GeoJSON (not enveloped) so Leaflet can consume directly
  } catch (err) {
    next(err);
  }
});

export default router;
