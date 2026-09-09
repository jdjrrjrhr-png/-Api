'use strict';

const express = require('express');
const router = express.Router();
const { getConfig } = require('../config');

/** Public — no secrets live in config.json. Frontend and the Roblox module
 *  both fetch this once and use it as the single source of truth for
 *  map bounds, min players for the live map, intervals, etc. */
router.get('/', (req, res) => {
    res.json(getConfig());
});

module.exports = router;
