const { Router } = require('express');
const services   = require('../../data/services.json');
const router     = Router();

router.get('/', (req, res) => {
  const { region, category, sow, q } = req.query;
  let data = services;

  if (region)   data = data.filter(s => s.regions.includes(region.toUpperCase()));
  if (category) data = data.filter(s => s.category === category.toUpperCase());
  if (sow !== undefined) {
    const sowBool = sow === 'true';
    data = data.filter(s => s.sowRequired === sowBool);
  }
  if (q) {
    const ql = q.toLowerCase();
    data = data.filter(s =>
      s.name.toLowerCase().includes(ql) ||
      (s.partNumber || s.id).toLowerCase().includes(ql) ||
      (s.description || '').toLowerCase().includes(ql)
    );
  }

  res.json(data);
});

router.get('/categories', (_req, res) => {
  const cats = [...new Set(services.map(s => s.category))].sort();
  res.json(cats);
});

router.get('/:id', (req, res) => {
  const svc = services.find(
    s => (s.partNumber || s.id) === req.params.id || s.id === req.params.id
  );
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  res.json(svc);
});

module.exports = router;
