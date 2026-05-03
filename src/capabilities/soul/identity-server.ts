import http from 'http';
import type crypto from 'crypto';
import { logger } from '../../logger.js';
import { signDocument } from './identity.js';

export interface IdentityServerOptions {
  port: number;
  didDocument: object;
  agentDescription: object;
  privateKey: crypto.KeyObject;
  verificationMethodId: string;
}

const SHUTDOWN_TIMEOUT_MS = 5000;

export function startIdentityServer(opts: IdentityServerOptions): http.Server {
  const signedDID = signDocument(
    opts.didDocument,
    opts.privateKey,
    opts.verificationMethodId,
  );

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && url === '/.well-known/did.json') {
      res.writeHead(200, { 'Content-Type': 'application/did+json' });
      res.end(JSON.stringify(signedDID));
      return;
    }

    if (req.method === 'GET' && url === '/.well-known/agent-description.json') {
      // Re-sign on every request so anp:lastSeen reflects "now".
      const fresh = {
        ...(opts.agentDescription as Record<string, unknown>),
        'anp:lastSeen': new Date().toISOString(),
      };
      const signed = signDocument(
        fresh,
        opts.privateKey,
        opts.verificationMethodId,
      );
      res.writeHead(200, { 'Content-Type': 'application/ld+json' });
      res.end(JSON.stringify(signed));
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      const did = (signedDID as { id?: string }).id ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', did }));
      return;
    }

    if (req.method === 'POST' && url === '/a2a') {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A2A protocol not yet implemented' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(opts.port, '127.0.0.1');
  return server;
}

export function stopIdentityServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn('Identity server did not close within timeout, forcing close');
      settle();
    }, SHUTDOWN_TIMEOUT_MS);
    server.close((err) => {
      clearTimeout(timer);
      if (err) logger.error({ err }, 'Identity server close error');
      settle();
    });
  });
}
