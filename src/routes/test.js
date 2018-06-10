const express = require('express');

const router = express.Router();

router.route('/test')
  .get(async (req, res) => {
    res.send('WE LOVE CITY YEAR.');
  });

module.exports = router;
