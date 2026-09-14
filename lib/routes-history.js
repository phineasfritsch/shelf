// Text history: GET /api/history (list of snapshots, newest first) and GET /api/history/:id (full text).
import { json, HttpError } from './http.js';

export function registerHistoryRoutes({ router, cfg, doc, log }) {
  router.add('GET', '/api/history', (req, res) => {
    json(res, 200, doc.history.list());
  });

  router.add('GET', '/api/history/:id', (req, res, ctx) => {
    const id = ctx.params.id;
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new HttpError(400, 'bad_id');
    const snap = doc.history.get(Number(id));
    if (!snap) throw new HttpError(404, 'not_found');
    json(res, 200, snap);
  });
}
