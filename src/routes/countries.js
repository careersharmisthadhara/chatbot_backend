const { Router } = require('express');
const countries  = require('../../data/countries.json');
const router     = Router();

router.get('/', (req, res) => {
  const { geo, onOffshore, cfsSite, status, q } = req.query;
  let data = countries;

  if (geo)        data = data.filter(c => c.geo === geo.toUpperCase());
  if (onOffshore) data = data.filter(c => c.onOffshore.toLowerCase() === onOffshore.toLowerCase());
  if (cfsSite)    data = data.filter(c => c.cfsSiteCode === cfsSite.toUpperCase());
  if (status)     data = data.filter(c => c.status === status);
  if (q) {
    const ql = q.toLowerCase();
    data = data.filter(c =>
      c.country.toLowerCase().includes(ql) ||
      c.countryCode.toLowerCase().includes(ql)
    );
  }

  res.json(data);
});

router.get('/sites', (_req, res) => {
  const sites = [...new Map(
    countries.map(c => [c.cfsSiteCode, { code: c.cfsSiteCode, name: c.cfsSite }])
  ).values()];
  res.json(sites);
});

module.exports = router;
