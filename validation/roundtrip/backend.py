#!/usr/bin/env python3
"""Identifiable test backend — Python twin of backend.js for hosts without
Node (e.g. lab VMs with no internet for installs). Same contract:
GET / -> JSON + X-Backend header; GET /health -> 200/503 toggled by
POST /admin/down|up.   usage: python3 backend.py <id> <port> [bind-ip]"""
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

ID = sys.argv[1] if len(sys.argv) > 1 else 'backend'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
BIND = sys.argv[3] if len(sys.argv) > 3 else '0.0.0.0'
healthy = True

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, code, body, ctype='application/json'):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Backend', ID)
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path == '/health':
            return self._send(200 if healthy else 503,
                              ('OK ' if healthy else 'DOWN ') + ID, 'text/plain')
        self._send(200, json.dumps({'backend': ID, 'port': PORT,
                                    'path': self.path, 'ts': int(time.time() * 1000),
                                    'client': self.client_address[0],
                                    'xff': self.headers.get('X-Forwarded-For')}))
    def do_POST(self):
        global healthy
        if self.path == '/admin/down':
            healthy = False
            return self._send(200, 'health=down ' + ID, 'text/plain')
        if self.path == '/admin/up':
            healthy = True
            return self._send(200, 'health=up ' + ID, 'text/plain')
        self._send(404, 'unknown', 'text/plain')

if __name__ == '__main__':
    print('backend %s listening on %s:%d' % (ID, BIND, PORT), flush=True)
    HTTPServer((BIND, PORT), H).serve_forever()
