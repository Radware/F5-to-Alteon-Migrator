#!/usr/bin/env node
'use strict';
// Identifiable test backend for the behavioral round-trip lab.
// Every response reports which backend served it, so the prober can measure
// load-balancing distribution and persistence through any LB in front.
//
//   node backend.js <id> [port=8080]
//
// Endpoints:
//   GET /            -> JSON {backend, port, path, ts}; also echoed in the
//                       X-Backend header (works for HEAD too)
//   GET /health      -> 200 "OK <id>" while up, 503 while administratively down
//   POST /admin/down -> health starts returning 503 (LB should eject this backend)
//   POST /admin/up   -> health returns 200 again
//
// /admin/* is meant to be called DIRECTLY (not through the LB) by probe.js to
// exercise the LB's health-check reaction.
const http = require('http');
const id = process.argv[2] || 'backend';
const port = parseInt(process.argv[3] || '8080', 10);
let healthy = true;

http.createServer((req, res) => {
  const respond = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json', 'X-Backend': id });
    res.end(body);
  };
  if (req.url === '/health') {
    return respond(healthy ? 200 : 503, (healthy ? 'OK ' : 'DOWN ') + id, 'text/plain');
  }
  if (req.method === 'POST' && req.url === '/admin/down') { healthy = false; return respond(200, 'health=down ' + id, 'text/plain'); }
  if (req.method === 'POST' && req.url === '/admin/up') { healthy = true; return respond(200, 'health=up ' + id, 'text/plain'); }
  respond(200, JSON.stringify({ backend: id, port, path: req.url, ts: Date.now() }));
}).listen(port, () => console.log('backend ' + id + ' listening on :' + port));
