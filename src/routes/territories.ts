/**
 * GET /api/territories — raw utility-territory GeoJSON for the map. Returned
 * unwrapped (it's a data document, like /health) and cached.
 */
import { Router } from 'express';
import { getTerritoriesGeoJson } from '../services/territory.service';

const router = Router();

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(getTerritoriesGeoJson());
});

export default router;
