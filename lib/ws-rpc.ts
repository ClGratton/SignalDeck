// SERVER-ONLY: a tiny RFC 6455 WebSocket client over node:tls / node:net.
//
// Why this exists instead of the global `WebSocket` (undici): the global one
// gives no per-connection TLS control, and Turbopack can't resolve a bare
// `undici`/`ws` import to get a dispatcher. The homelab's TrueNAS/HA endpoints
// are often reached by INTERNAL IP with a cert issued for the public hostname,
// so `*_VERIFY_TLS=false` MUST be honored on the socket — which the global
// WebSocket silently ignored, making TrueNAS unreachable whenever the host was
// switched from the domain to its LAN IP.
//
// Only the surface the console RPC code uses is implemented: addEventListener
// (open/message/error/close), send(text), close(). Client frames are masked per
// spec; server frames (unmasked, possibly fragmented) are reassembled to UTF-8.

import 'server-only';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

type MessageListener = (ev: { data: string }) => void;
type VoidListener = () => void;

class LabSocket {
  private emitter = new EventEmitter();
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buf = Buffer.alloc(0);
  private handshakeDone = false;
  private closed = false;
  private frag: { chunks: Buffer[] } | null = null;

  constructor(url: string, verifyTls: boolean) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      queueMicrotask(() => this.fail('invalid url'));
      return;
    }
    const secure = u.protocol === 'wss:';
    const host = u.hostname;
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    const path = (u.pathname || '/') + (u.search || '');
    const key = crypto.randomBytes(16).toString('base64');

    const onConnect = () => {
      this.socket?.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}${u.port ? ':' + u.port : ''}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    };

    const sock = secure
      ? tls.connect(
          {
            host,
            port,
            // SNI only for real hostnames — RFC 6066 forbids an IP as ServerName
            // (and Node now warns/ignores it). The cert mismatch that follows is
            // exactly what rejectUnauthorized:false is here to tolerate.
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: verifyTls,
          },
          onConnect,
        )
      : net.connect({ host, port }, onConnect);

    this.socket = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', (e: Error) => this.fail(e.message));
    sock.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emitter.emit('close');
      }
    });
  }

  private fail(msg: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emitter.emit('error', { message: msg });
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.handshakeDone) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx === -1) return; // wait for the full response header
      const header = this.buf.subarray(0, idx).toString('latin1');
      this.buf = this.buf.subarray(idx + 4);
      if (!/^HTTP\/1\.1 101/.test(header)) {
        return this.fail('handshake failed: ' + (header.split('\r\n')[0] || 'no status'));
      }
      this.handshakeDone = true;
      this.emitter.emit('open');
    }
    this.parseFrames();
  }

  private parseFrames(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return; // wait for the full payload
      let payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) return this.close(); // server close
    if (opcode === 0x9) return this.writeFrame(0xa, payload); // ping → pong
    if (opcode === 0xa) return; // pong
    if (opcode === 0x0) {
      if (this.frag) this.frag.chunks.push(payload); // continuation
    } else {
      this.frag = { chunks: [payload] }; // text/binary start
    }
    if (fin && this.frag) {
      const full = Buffer.concat(this.frag.chunks);
      this.frag = null;
      this.emitter.emit('message', { data: full.toString('utf8') });
    }
  }

  send(data: string): void {
    this.writeFrame(0x1, Buffer.from(data, 'utf8'));
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] |= 0x80; // client frames MUST be masked
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch {
      this.fail('write failed');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
    this.emitter.emit('close');
  }

  addEventListener(type: 'message', cb: MessageListener): void;
  addEventListener(type: 'open' | 'close' | 'error', cb: VoidListener): void;
  addEventListener(type: string, cb: (ev: { data: string }) => void): void {
    this.emitter.on(type, cb as (...args: unknown[]) => void);
  }
}

export type { LabSocket };

/** Open a WebSocket honoring `verifyTls` (false tolerates self-signed / IP-host
 *  cert mismatches — the homelab norm). Drop-in for the subset of the global
 *  WebSocket API the console RPC code uses. */
export function openLabSocket(url: string, verifyTls: boolean): LabSocket {
  return new LabSocket(url, verifyTls);
}
