const express = require('express');

const router = express.Router();

router.route('/test')
  .get(async (req, res) => {
    res.send('Test');
  });

module.exports = router;
