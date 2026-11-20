'use strict';

/**
 * Vercel Serverless Function Entry Point
 * Routes all HTTP, API, pairing, and cron-job.org keep-alive requests to Express app.
 */
const app = require('../server');

module.exports = app;
