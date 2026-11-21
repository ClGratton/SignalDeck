#!/usr/bin/env python3
"""Narrow network boundary for the LAP public-search endpoint."""
import http.client
import ipaddress
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LISTEN = os.environ['LAP_RELAY_LISTEN']
PORT = int(os.environ['LAP_RELAY_PORT'])
ALLOWED = {ipaddress.ip_address(x.strip()) for x in os.environ['LAP_RELAY_ALLOWED_IPS'].split(',') if x.strip()}
TOKEN_FILE = Path(os.environ['LAP_RELAY_TOKEN_FILE'])
PATH = '/api/agent/lap-search'

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass
    def answer(self, status, data=b''):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        try:
            peer = ipaddress.ip_address(self.client_address[0])
            if peer not in ALLOWED or self.path != PATH or any(h in self.headers for h in ('Origin', 'CF-Ray', 'CF-Connecting-IP', 'Sec-Fetch-Site')):
                return self.answer(404)
            length = int(self.headers.get('Content-Length', '-1'))
            if length < 0 or length > 2048 or self.headers.get('Transfer-Encoding'):
                return self.answer(400)
            self.connection.settimeout(10)
            body = self.rfile.read(length)
            if len(body) != length:
                return self.answer(400)
            relay_token = TOKEN_FILE.read_text(encoding='utf-8').strip()
            if len(relay_token) < 32:
                return self.answer(503)
            connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=25)
            connection.request('POST', PATH, body, {'Content-Type': self.headers.get('Content-Type', ''), 'Authorization': self.headers.get('Authorization', ''), 'X-Lap-Relay-Token': relay_token})
            response = connection.getresponse()
            result = response.read(16385)
            connection.close()
            if len(result) > 16384:
                return self.answer(502)
            return self.answer(response.status, result)
        except (OSError, ValueError, http.client.HTTPException):
            return self.answer(502)
    def do_GET(self):
        self.answer(404)
    def do_OPTIONS(self):
        self.answer(404)

ThreadingHTTPServer((LISTEN, PORT), Handler).serve_forever()
